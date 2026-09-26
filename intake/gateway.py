#!/usr/bin/env python3
"""Narrow public HMAC intake gateway for ManagerAI.

The gateway has no administrative or execution endpoints. It verifies signed
events, persists delivery state in SQLite, and forwards accepted payloads to
the private ManagerAI application with a freshly generated signature.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import math
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urlparse
from urllib.request import Request, urlopen

HOST = os.environ.get("MANAGERAI_INTAKE_HOST", "172.17.0.1")
PORT = int(os.environ.get("MANAGERAI_INTAKE_PORT", "13007"))
DATABASE = Path(os.environ.get("MANAGERAI_INTAKE_DATABASE", str(Path.home() / '.local/share/managerai-intake/events.sqlite3')))
FORWARD_URL = os.environ.get("MANAGERAI_INTAKE_FORWARD_URL", "http://172.17.0.1:13006/api/webhooks/intake")
SIGNING_SECRET = os.environ.get("MANAGERAI_INTAKE_SIGNING_SECRET", "")
STATUS_TOKEN = os.environ.get("MANAGERAI_INTAKE_STATUS_TOKEN", "")
PRINCIPALS_FILE = Path(os.environ.get("MANAGERAI_CONTACT_PRINCIPALS", str(Path.home() / '.config/managerai-intake/contact-principals.json')))
BOT_HANDLES_FILE = Path(os.environ.get("MANAGERAI_BOT_HANDLES", str(Path.home() / '.local/share/managerai-intake/bot-handles.json')))
PUBLIC_CONTACT_URL = os.environ.get("MANAGERAI_CONTACT_PUBLIC_URL", "https://hooks.managerai.example.com/v1/agent-contact")
MAX_BODY = 100_000
MAX_ATTEMPTS = 6
WINDOW_SECONDS = 300
STOP = threading.Event()
PRINCIPAL_LOCK = threading.Lock()


def connect() -> sqlite3.Connection:
    DATABASE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    DATABASE.parent.chmod(0o700)
    database = sqlite3.connect(DATABASE, timeout=10)
    database.row_factory = sqlite3.Row
    database.execute("PRAGMA journal_mode=WAL")
    database.execute("PRAGMA busy_timeout=10000")
    database.executescript("""
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE,
        agent_id TEXT NOT NULL, event_type TEXT NOT NULL, payload BLOB NOT NULL,
        payload_hash TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
        received_at INTEGER NOT NULL, next_attempt_at INTEGER, delivered_at INTEGER,
        last_http_status INTEGER, last_error_code TEXT
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, event_id TEXT NOT NULL, attempt_number INTEGER NOT NULL,
        started_at INTEGER NOT NULL, completed_at INTEGER, http_status INTEGER,
        result TEXT NOT NULL, error_code TEXT,
        UNIQUE(event_id, attempt_number)
      );
      CREATE INDEX IF NOT EXISTS events_retry_idx ON events(status, next_attempt_at);
    """)
    database.commit()
    return database


def signature(secret: str, timestamp: str, body: bytes) -> str:
    return hmac.new(secret.encode(), timestamp.encode() + b"." + body, hashlib.sha256).hexdigest()


def safe_equal(left: str, right: str) -> bool:
    return bool(left and right and hmac.compare_digest(left, right))


def contact_principals() -> dict[str, dict]:
    try:
        parsed = json.loads(PRINCIPALS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    principals = parsed.get("principals") if isinstance(parsed, dict) else None
    return {str(item.get("id")): item for item in principals or [] if isinstance(item, dict) and item.get("status") == "active"}


def token_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def read_json_file(path: Path, fallback: dict) -> dict:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return fallback
    except (OSError, json.JSONDecodeError) as error:
        raise ValueError("private_state_unavailable") from error
    if not isinstance(parsed, dict):
        raise ValueError("private_state_invalid")
    return parsed


def write_private_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    path.parent.chmod(0o700)
    pending = path.with_name(f"{path.name}.{os.getpid()}.{uuid.uuid4().hex}.pending")
    pending.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    pending.chmod(0o600)
    pending.replace(path)
    path.chmod(0o600)


def create_bot_handle(handles_file: Path = BOT_HANDLES_FILE) -> dict:
    """Create a URL whose secret setup token is stored only as a hash."""
    with PRINCIPAL_LOCK:
        state = read_json_file(handles_file, {"schemaVersion": 1, "handles": []})
        handles = state.get("handles")
        if not isinstance(handles, list):
            raise ValueError("private_state_invalid")
        setup_key = secrets.token_urlsafe(32)
        principal = f"bot-{uuid.uuid4().hex[:16]}"
        handles.append({"keyHash": token_hash(setup_key), "principal": principal, "issuedAt": int(time.time() * 1000)})
        write_private_json(handles_file, {"schemaVersion": 1, "handles": handles})
        setup_url = f"{urlparse(PUBLIC_CONTACT_URL)._replace(query='', fragment='').geturl()}?{urlencode({'key': setup_key})}"
        return {"setupUrl": setup_url, "principal": principal}


def redeem_bot_handle(setup_key: str, handles_file: Path = BOT_HANDLES_FILE, registry_file: Path = PRINCIPALS_FILE) -> dict:
    """Consume one setup key and return a new reusable bearer key exactly once."""
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", setup_key):
        raise PermissionError("invalid_or_used_bot_handle")
    with PRINCIPAL_LOCK:
        state = read_json_file(handles_file, {"schemaVersion": 1, "handles": []})
        handles = state.get("handles")
        if not isinstance(handles, list):
            raise ValueError("private_state_invalid")
        digest = token_hash(setup_key)
        handle = next((item for item in handles if isinstance(item, dict) and safe_equal(str(item.get("keyHash", "")), digest)), None)
        if not handle:
            raise PermissionError("invalid_or_used_bot_handle")
        principal = str(handle.get("principal", ""))
        if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{1,63}", principal):
            raise ValueError("private_state_invalid")
        reusable_key = f"mai_{secrets.token_urlsafe(32)}"
        registry = read_json_file(registry_file, {"schemaVersion": 1, "principals": []})
        principals = registry.get("principals")
        if not isinstance(principals, list):
            raise ValueError("principal_registry_invalid")
        replacement = {"id": principal, "status": "active", "bearerHash": token_hash(reusable_key), "allowedProjects": [], "allowedAuthority": ["notify"]}
        updated_principals = [item for item in principals if not isinstance(item, dict) or item.get("id") != principal] + [replacement]
        write_private_json(registry_file, {**registry, "schemaVersion": registry.get("schemaVersion", 1), "principals": sorted(updated_principals, key=lambda item: str(item.get("id", "")) if isinstance(item, dict) else "")})
        write_private_json(handles_file, {"schemaVersion": 1, "handles": [item for item in handles if item is not handle]})
        return {"principal": principal, "reusableKey": reusable_key}


def render_bot_setup(principal: str, reusable_key: str) -> str:
    return f"""# ManagerAI bot setup

Setup is complete. This single response contains everything you need. Save the reusable key now; this setup URL has already been consumed and cannot reveal it again.

## Reusable bot key

`{reusable_key}`

Store it privately as `MANAGERAI_BOT_KEY`. Never commit it, paste it into prompts, or include it in logs or screenshots.

## What you must do now

1. Save the reusable key privately as `MANAGERAI_BOT_KEY`.
2. If the owner supplied an actual update or notification to send with this setup request, fill the canvas below with that message and send it now.
3. If this was setup only, do not send a meaningless test message. Confirm privately that setup is complete, then wait until there is a real owner-facing update.

## Your ongoing job

Use this channel whenever the owner asked you to notify them, when requested work succeeds, when work is blocked and needs owner input, or when a result must reach Assistant in Slack. For every such event:

1. Write one concise, useful, human-readable update in `message`. Say what happened, the result, and any action the owner must take.
2. Set `idempotency_key` to a stable unique ID for that exact event. Reuse the same ID only when retrying the same event.
3. POST the filled canvas to the endpoint with `Authorization: Bearer $MANAGERAI_BOT_KEY`.
4. Treat HTTP `202` as accepted and retain the returned ManagerAI event ID for audit and safe retry.

This is the generic ManagerAI-to-Assistant Slack message channel. It does not use HMAC signatures, fixed triggers, `marketing-x-bot`, or `marketing_posts_published`, and you do not need to find or select another contract.

## Empty canvas

```json
{{
  "type": "notification.message",
  "idempotency_key": "",
  "message": ""
}}
```

## How to send it

Save the edited JSON as `managerai-message.json`, then run:

```bash
curl -fsS -X POST {PUBLIC_CONTACT_URL} \\
  -H "Authorization: Bearer $MANAGERAI_BOT_KEY" \\
  -H "Content-Type: application/json" \\
  --data-binary @managerai-message.json
```

A successful response is HTTP 202 and contains a durable event ID. For a timeout, rate limit, or 5xx response, retry the same JSON with the same idempotency key. Do not send credentials or private data in the message.

Principal: `{principal}`
"""


def bearer_principal(headers) -> tuple[str, dict] | tuple[None, None]:
    reusable_key = headers.get("authorization", "").removeprefix("Bearer ").strip()
    if not reusable_key.startswith("mai_"):
        return None, None
    digest = token_hash(reusable_key)
    for principal_id, principal in contact_principals().items():
        if safe_equal(str(principal.get("bearerHash", "")), digest):
            return principal_id, principal
    return None, None


def validate_event(headers, body: bytes, contact_only: bool = False) -> tuple[dict, str, str]:
    try:
        payload = json.loads(body)
    except json.JSONDecodeError as error:
        raise ValueError("invalid_json") from error
    if not isinstance(payload, dict):
        raise ValueError("invalid_payload")
    event_type = str(payload.get("type", ""))[:120]
    idempotency_key = str(payload.get("idempotency_key", ""))[:180]
    credential_markers = (
        "-----begin private key-----", "-----begin openssh private key-----",
        "password=", "secret=", "token=", "api_key=", "apikey=",
        "authorization: bearer ", "cookie:", "set-cookie:",
    )
    if event_type == "notification.message" and contact_only:
        principal_id, principal = bearer_principal(headers)
        message = str(payload.get("message", "")).strip()
        if not principal_id or not principal:
            raise PermissionError("bearer_rejected")
        if principal.get("allowedAuthority") != ["notify"] or principal.get("allowedProjects") != []:
            raise PermissionError("authority_rejected")
        if not idempotency_key or len(idempotency_key) > 180 or not message or len(message) > 3500:
            raise ValueError("invalid_notification_message")
        if any(marker in message.lower() for marker in credential_markers):
            raise ValueError("credential_material_rejected")
        return {"type": event_type, "idempotency_key": idempotency_key, "principal": principal_id, "authority": ["notify"], "message": message}, principal_id, idempotency_key

    agent_id = headers.get("x-agent-id", "").strip()[:120]
    timestamp = headers.get("x-timestamp", "")
    provided = headers.get("x-signature", "").removeprefix("sha256=").lower()
    try:
        unix_seconds = int(timestamp)
    except ValueError as error:
        raise PermissionError("invalid_signature_metadata") from error
    if not agent_id or abs(int(time.time()) - unix_seconds) > WINDOW_SECONDS:
        raise PermissionError("signature_rejected")
    if event_type == "issue.created" and not contact_only:
        if not SIGNING_SECRET:
            raise ValueError("not_configured")
        if not safe_equal(signature(SIGNING_SECRET, timestamp, body), provided):
            raise PermissionError("signature_rejected")
        if not idempotency_key or not str(payload.get("title", "")).strip():
            raise ValueError("unsupported_or_incomplete_event")
        return payload, agent_id, idempotency_key
    if event_type not in {"agent.message", "social.post.published", "notification.triggered"} or not contact_only:
        raise ValueError("unsupported_or_incomplete_event")
    principal = contact_principals().get(agent_id)
    secret = str(principal.get("secret", "")) if principal else ""
    if len(secret) < 32 or not safe_equal(signature(secret, timestamp, body), provided):
        raise PermissionError("signature_rejected")
    authority = payload.get("authority")
    if not idempotency_key or not isinstance(authority, list):
        raise ValueError("unsupported_or_incomplete_event")
    supported = {"inspect", "edit", "test", "commit", "push", "restart", "deploy", "notify"}
    requested = list(dict.fromkeys(str(item) for item in authority))
    allowed_authority = set(str(item) for item in principal.get("allowedAuthority", []))
    if not requested or len(requested) > 8 or not set(requested).issubset(supported) or not set(requested).issubset(allowed_authority):
        raise PermissionError("authority_rejected")
    if event_type == "notification.triggered":
        if requested != ["notify"]:
            raise PermissionError("authority_rejected")
        if str(payload.get("principal", "")) != agent_id:
            raise PermissionError("principal_rejected")
        trigger = str(payload.get("trigger", "")).strip()
        if not re.fullmatch(r"[a-z][a-z0-9_]{1,63}", trigger):
            raise ValueError("invalid_trigger")
        variables = payload.get("variables", {})
        if not isinstance(variables, dict) or len(variables) > 24:
            raise ValueError("invalid_notification_variables")
        reserved = {"agent", "authority", "idempotency_key", "platform", "platforms", "principal", "trigger", "trigger_key", "type"}
        normalized_variables = {}
        variable_length = 0
        for key, value in variables.items():
            if not isinstance(key, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,63}", key) or key in reserved:
                raise ValueError("invalid_notification_variables")
            if not isinstance(value, (str, int, float, bool)) or value is None or isinstance(value, float) and not math.isfinite(value):
                raise ValueError("invalid_notification_variables")
            rendered = str(value)
            variable_length += len(rendered)
            if len(rendered) > 1200 or variable_length > 8000:
                raise ValueError("invalid_notification_variables")
            if any(marker in rendered.lower() for marker in credential_markers):
                raise ValueError("credential_material_rejected")
            normalized_variables[key] = rendered
        platforms = payload.get("platforms", [])
        if not isinstance(platforms, list) or len(platforms) > 2:
            raise ValueError("invalid_notification_platforms")
        normalized_platforms = list(dict.fromkeys(str(item).strip().lower() for item in platforms))
        if len(normalized_platforms) != len(platforms) or any(item not in {"linkedin", "x"} for item in normalized_platforms):
            raise ValueError("invalid_notification_platforms")
        normalized = {
            "type": event_type, "idempotency_key": idempotency_key,
            "principal": agent_id, "authority": requested,
            "trigger": trigger, "variables": normalized_variables,
        }
        if normalized_platforms:
            normalized["platforms"] = normalized_platforms
        return normalized, agent_id, idempotency_key

    if event_type == "social.post.published":
        if requested != ["notify"]:
            raise PermissionError("authority_rejected")
        platform = str(payload.get("platform", "")).strip().lower()
        post_url = str(payload.get("post_url", "")).strip()
        title = str(payload.get("title", "")).strip()
        summary = str(payload.get("summary", "")).strip()
        parsed_url = urlparse(post_url)
        hostname = (parsed_url.hostname or "").lower().removeprefix("www.")
        valid_linkedin = platform == "linkedin" and (hostname == "linkedin.com" or hostname.endswith(".linkedin.com"))
        valid_x = platform == "x" and (hostname in {"x.com", "twitter.com"} or hostname.endswith(".x.com") or hostname.endswith(".twitter.com"))
        if not title or len(title) > 240 or len(summary) > 1200 or parsed_url.scheme != "https" or not (valid_linkedin or valid_x):
            raise ValueError("invalid_social_post")
        if any(marker in f"{title}\n{summary}".lower() for marker in credential_markers):
            raise ValueError("credential_material_rejected")
        normalized = {
            "type": event_type, "idempotency_key": idempotency_key,
            "principal": agent_id, "authority": requested,
            "platform": platform, "post_url": post_url,
            "title": title, "summary": summary,
        }
        if isinstance(payload.get("published_at"), (int, float)):
            normalized["published_at"] = int(payload["published_at"])
        return normalized, agent_id, idempotency_key

    project = str(payload.get("project", ""))
    message = str(payload.get("message", ""))
    if not project or not message or len(message) > 20_000:
        raise ValueError("unsupported_or_incomplete_event")
    if not project.replace("-", "").replace("_", "").replace(".", "").isalnum() or len(project) > 64:
        raise ValueError("invalid_project")
    allowed_projects = principal.get("allowedProjects") if isinstance(principal.get("allowedProjects"), list) else []
    if "*" not in allowed_projects and project not in allowed_projects:
        raise PermissionError("project_rejected")
    if "notify" in requested:
        raise PermissionError("authority_rejected")
    if any(marker in message.lower() for marker in credential_markers):
        raise ValueError("credential_material_rejected")
    normalized = {
        "type": "agent.message", "idempotency_key": idempotency_key,
        "project": project, "message": message,
        "principal": agent_id, "authority": requested,
    }
    return normalized, agent_id, idempotency_key


def deliver(event_id: str) -> None:
    database = connect()
    row = database.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()
    if not row or row["status"] == "delivered":
        database.close()
        return
    claim = database.execute("UPDATE events SET status='delivering' WHERE id=? AND status IN ('accepted','retrying')", (event_id,))
    database.commit()
    if claim.rowcount != 1:
        database.close()
        return
    attempt = int(row["attempts"]) + 1
    started = int(time.time() * 1000)
    timestamp = str(int(time.time()))
    body = bytes(row["payload"])
    request = Request(FORWARD_URL, data=body, method="POST", headers={
        "content-type": "application/json", "x-agent-id": row["agent_id"],
        "x-timestamp": timestamp, "x-signature": f"sha256={signature(SIGNING_SECRET, timestamp, body)}",
        "x-managerai-source-id": event_id,
    })
    status = 0
    result = ""
    error_code = None
    try:
        with urlopen(request, timeout=15) as response:  # noqa: S310 - fixed private deployment URL
            status = response.status
            result = response.read(2048).decode("utf-8", errors="replace")
        delivered = 200 <= status < 300
    except HTTPError as error:
        status = error.code
        result = error.read(2048).decode("utf-8", errors="replace")
        error_code = f"http_{status}"
        delivered = False
    except (URLError, OSError, TimeoutError) as error:
        result = type(error).__name__
        error_code = "forward_unavailable"
        delivered = False
    completed = int(time.time() * 1000)
    terminal = not delivered and attempt >= MAX_ATTEMPTS
    next_attempt = None if delivered or terminal else completed + min(300_000, 5_000 * (2 ** (attempt - 1)))
    state = "delivered" if delivered else "dead_letter" if terminal else "retrying"
    database.execute("INSERT INTO attempts VALUES (?,?,?,?,?,?,?,?)", (f"att_{uuid.uuid4().hex}", event_id, attempt, started, completed, status or None, result[:2000], error_code))
    database.execute("UPDATE events SET status=?,attempts=?,next_attempt_at=?,delivered_at=?,last_http_status=?,last_error_code=? WHERE id=?", (state, attempt, next_attempt, completed if delivered else None, status or None, error_code, event_id))
    database.commit()
    database.close()


def retry_loop() -> None:
    while not STOP.wait(2):
        database = connect()
        rows = database.execute("SELECT id FROM events WHERE status IN ('accepted','retrying') AND COALESCE(next_attempt_at,0)<=? ORDER BY received_at LIMIT 20", (int(time.time() * 1000),)).fetchall()
        database.close()
        for row in rows:
            deliver(row["id"])


class Handler(BaseHTTPRequestHandler):
    server_version = "ManagerAIIntake/1"

    def send_json(self, status: int, payload: dict) -> None:
        encoded = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.send_header("cache-control", "no-store")
        self.send_header("x-robots-tag", "noindex, nofollow, noarchive")
        self.end_headers()
        self.wfile.write(encoded)

    def send_markdown(self, status: int, payload: str) -> None:
        encoded = payload.encode()
        self.send_response(status)
        self.send_header("content-type", "text/markdown; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.send_header("cache-control", "no-store")
        self.send_header("x-robots-tag", "noindex, nofollow, noarchive")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:  # noqa: N802
        parsed_request = urlparse(self.path)
        if parsed_request.path == "/health":
            self.send_json(200 if SIGNING_SECRET else 503, {"status": "ok" if SIGNING_SECRET else "not_configured"})
            return
        if parsed_request.path == "/v1/agent-contact" and parsed_request.query:
            setup_key = parse_qs(parsed_request.query).get("key", [""])[0]
            try:
                result = redeem_bot_handle(setup_key)
            except PermissionError:
                self.send_markdown(410, "# Bot handle unavailable\n\nThis setup URL is invalid or has already been used. Ask the owner to copy a new bot handle.\n")
                return
            except ValueError:
                self.send_markdown(503, "# Bot setup unavailable\n\nThe private setup service is temporarily unavailable.\n")
                return
            self.send_markdown(200, render_bot_setup(result["principal"], result["reusableKey"]))
            return
        if parsed_request.path == "/v1/agent-contact":
            self.send_markdown(200, """# ManagerAI project-agent contact

This is the complete authenticated contact protocol for every registered ManagerAI project agent. The public URL does not grant authority and never returns a key. Use a previously issued private principal ID and secret.

POST this same URL with `Content-Type: application/json` plus headers `x-agent-id`, `x-timestamp`, and `x-signature: sha256=<hex>`. The signature is HMAC-SHA256 over `<unix-timestamp>.<exact-request-body>`. The timestamp must be within five minutes.

For project work, the JSON body is `{"type":"agent.message","idempotency_key":"<stable unique value>","project":"<registered project slug>","message":"<request>","authority":["inspect","edit","test"]}`. Authority may contain only scopes granted to that principal: `inspect`, `edit`, `test`, `commit`, `push`, `restart`, or `deploy`. The project must be allowed by the principal.

For a reusable Assistant notification contract, use `{"type":"notification.triggered","idempotency_key":"<stable event id>","principal":"<same principal as x-agent-id>","authority":["notify"],"trigger":"<fixed owner-configured trigger_key>","platforms":["linkedin","x"],"variables":{"campaign":"<declared value>"}}`. The fixed trigger selects one enabled contract for that principal; it is never a message variable. `platforms` is optional and may contain `linkedin`, `x`, or both. `variables` must exactly match the placeholders declared by the selected contract; a static template uses `{}`. ManagerAI renders the owner-controlled multi-line template and asks Assistant to post it only to the contract's allowlisted Slack channel.

The legacy social completion body remains supported: `{"type":"social.post.published","idempotency_key":"<stable platform post id>","principal":"<same principal as x-agent-id>","authority":["notify"],"platform":"linkedin","post_url":"https://www.linkedin.com/...","title":"<post title>","summary":"<optional short note>","published_at":<optional unix milliseconds>}`. `platform` is `linkedin` or `x`; the HTTPS URL must match that platform.

Reuse the same idempotency key for retries.

A successful HTTP 202 response returns a durable intake event identifier. Delivery into ManagerAI is asynchronous; the resulting message, run, and agent reply appear in the selected project's Chat history. Never include passwords, tokens, cookies, private keys, magic-login URLs, database contents, or private environments. A key never grants sudo, root, destructive operations, arbitrary checkout selection, or authority not explicitly listed in both the principal and signed message.
""")
            return
        if parsed_request.path == "/v1/status":
            provided = self.headers.get("authorization", "").removeprefix("Bearer ")
            if not STATUS_TOKEN or not safe_equal(provided, STATUS_TOKEN):
                self.send_json(401, {"error": "Unauthorized"})
                return
            database = connect()
            counts = {row["status"]: row["count"] for row in database.execute("SELECT status,COUNT(*) AS count FROM events GROUP BY status")}
            recent = [dict(row) for row in database.execute("SELECT id,idempotency_key,agent_id,event_type,status,attempts,received_at,next_attempt_at,delivered_at,last_http_status,last_error_code FROM events ORDER BY received_at DESC LIMIT 100")]
            database.close()
            self.send_json(200, {"counts": counts, "events": recent})
            return
        self.send_json(404, {"error": "Not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path == "/v1/agent-contact" and safe_equal(self.headers.get("authorization", "").removeprefix("Bearer "), STATUS_TOKEN):
            provided = self.headers.get("authorization", "").removeprefix("Bearer ")
            if not STATUS_TOKEN or not safe_equal(provided, STATUS_TOKEN):
                self.send_json(401, {"error": "Unauthorized"})
                return
            try:
                length = int(self.headers.get("content-length", "0"))
            except ValueError:
                length = 0
            if length <= 0 or length > 4096:
                self.send_json(413, {"error": "Payload too large or missing"})
                return
            self.rfile.read(length)
            try:
                result = create_bot_handle()
            except ValueError as error:
                self.send_json(503, {"error": str(error)})
                return
            self.send_json(201, result)
            return
        if self.path not in {"/v1/events", "/v1/agent-contact"}:
            self.send_json(404, {"error": "Not found"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY:
            self.send_json(413, {"error": "Payload too large or missing"})
            return
        body = self.rfile.read(length)
        try:
            payload, agent_id, idempotency_key = validate_event(self.headers, body, self.path == "/v1/agent-contact")
            body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
        except PermissionError as error:
            self.send_json(403 if str(error) in {"project_rejected", "authority_rejected", "principal_rejected"} else 401, {"error": str(error)})
            return
        except ValueError as error:
            status = 503 if str(error) == "not_configured" else 400
            self.send_json(status, {"error": str(error)})
            return
        event_id = f"evt_{uuid.uuid4().hex}"
        storage_idempotency_key = f"contact:{agent_id}:{idempotency_key}" if self.path == "/v1/agent-contact" else idempotency_key
        database = connect()
        try:
            database.execute("INSERT INTO events (id,idempotency_key,agent_id,event_type,payload,payload_hash,status,received_at,next_attempt_at) VALUES (?,?,?,?,?,?,?,?,?)", (event_id, storage_idempotency_key, agent_id, payload["type"], body, hashlib.sha256(body).hexdigest(), "accepted", int(time.time() * 1000), 0))
            database.commit()
        except sqlite3.IntegrityError:
            existing = database.execute("SELECT id,status FROM events WHERE idempotency_key=?", (storage_idempotency_key,)).fetchone()
            database.close()
            self.send_json(202, {"accepted": True, "duplicate": True, "eventId": existing["id"], "status": existing["status"]})
            return
        database.close()
        threading.Thread(target=deliver, args=(event_id,), daemon=True).start()
        self.send_json(202, {"accepted": True, "eventId": event_id})

    def log_message(self, format_string: str, *args) -> None:
        rendered = format_string % args
        rendered = re.sub(r"(/v1/agent-contact)\?[^ ]+", r"\1?key=[redacted]", rendered)
        print(f"{self.address_string()} {rendered}", flush=True)


def main() -> None:
    database = connect()
    database.execute("UPDATE events SET status='retrying',next_attempt_at=0 WHERE status='delivering'")
    database.commit()
    database.close()
    worker = threading.Thread(target=retry_loop, daemon=True)
    worker.start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    try:
        server.serve_forever()
    finally:
        STOP.set()
        server.server_close()


if __name__ == "__main__":
    main()
