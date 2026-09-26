#!/usr/bin/env python3
"""Private report-only HTTP transport; contains no setup or arbitrary job routes."""
import hmac
import ipaddress
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import re
import threading

from reports import ReportRuntime

MAX_BODY = 16 * 1024
MAX_RESPONSE = 2 * 1024 * 1024
MAX_ARTIFACT = 25 * 1024 * 1024
IDENTITY = re.compile(r"[A-Za-z0-9_-]{1,180}\Z")


class ReportServer(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16

    def __init__(self, address, runtime, token):
        if len(token) < 32:
            raise ValueError("report_token_too_short")
        self.runtime, self.token = runtime, token.encode()
        self.slots = threading.BoundedSemaphore(16)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "ManagerAIReports/1"

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_args):
        pass  # Never log identifiers, authorization headers or artifact paths.

    def respond(self, code, value):
        data = json.dumps(value, separators=(",", ":")).encode()
        if len(data) > MAX_RESPONSE:
            code, data = 500, b'{"error":"report_response_too_large"}'
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(data)

    def authorize(self):
        values = self.headers.get_all("Authorization", [])
        supplied = values[0].encode() if len(values) == 1 else b""
        if not hmac.compare_digest(supplied, b"Bearer " + self.server.token):
            self.respond(401, {"error": "unauthorized"})
            return False
        return True

    def do_GET(self):
        self.dispatch(False)

    def do_POST(self):
        self.dispatch(True)

    def do_HEAD(self):
        if self.authorize():
            self.respond(405, {"error": "method_not_allowed"})

    do_PUT = do_DELETE = do_PATCH = do_OPTIONS = do_TRACE = do_CONNECT = do_HEAD

    def dispatch(self, post):
        if not self.authorize():
            return
        try:
            runtime = self.server.runtime
            if post and self.path == "/v1/reports":
                sizes = self.headers.get_all("Content-Length", [])
                if self.headers.get("Transfer-Encoding") or len(sizes) != 1 or not sizes[0].isdigit():
                    self.respond(400, {"error": "invalid_report_body"}); return
                size = int(sizes[0])
                if size > MAX_BODY:
                    self.respond(413, {"error": "report_body_too_large"}); return
                if self.headers.get_content_type() != "application/json":
                    self.respond(415, {"error": "json_required"}); return
                try:
                    data = self.rfile.read(size)
                    payload = json.loads(data)
                    if len(data) != size or not isinstance(payload, dict):
                        raise ValueError()
                except (ValueError, UnicodeDecodeError):
                    self.respond(400, {"error": "invalid_report_body"}); return
                self.respond(202, runtime.accept(payload)); return
            if not post and self.path == "/v1/reports/preflight":
                self.respond(200, runtime.preflight()); return
            parts = self.path.split("/")
            if not post and len(parts) in (4, 6) and parts[:3] == ["", "v1", "reports"] and IDENTITY.fullmatch(parts[3]):
                run_id = parts[3]
                if len(parts) == 4:
                    runtime.recover_interrupted()
                    state = runtime.finalize(run_id)
                    if state and state.get("status") == "waiting_for_review" and hasattr(runtime, "schedule_review"):
                        runtime.schedule_review(run_id)
                    self.respond(200 if state else 404, state or {"error": "report_not_found"}); return
                if IDENTITY.fullmatch(parts[5]):
                    if parts[4] == "evidence":
                        self.respond(200, runtime.evidence(run_id, parts[5])); return
                    if parts[4] == "artifacts":
                        meta, data = runtime.artifact(run_id, parts[5])
                        if not isinstance(data, bytes) or len(data) > MAX_ARTIFACT or len(data) != meta["byteLength"]:
                            raise ValueError("invalid_artifact")
                        self.send_response(200)
                        self.send_header("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                        self.send_header("Content-Length", str(len(data)))
                        self.send_header("Cache-Control", "no-store")
                        self.send_header("X-Content-Type-Options", "nosniff")
                        self.end_headers()
                        for offset in range(0, len(data), 65536):
                            self.wfile.write(data[offset:offset + 65536])
                        return
            self.respond(404, {"error": "report_not_found"})
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except (ValueError, OSError, KeyError):
            self.respond(409, {"error": "report_unavailable"})
        except Exception:
            self.respond(500, {"error": "report_internal_error"})


def main():
    bind = os.environ.get("MANAGERAI_REPORT_BIND", "127.0.0.1")
    address = ipaddress.ip_address(bind)
    if address.version != 4 or not (address.is_loopback or any(address in network for network in (
        ipaddress.ip_network("10.0.0.0/8"), ipaddress.ip_network("172.16.0.0/12"), ipaddress.ip_network("192.168.0.0/16")))):
        raise ValueError("report_bind_must_be_private_ipv4")
    config = Path(os.environ["MANAGERAI_REPORT_CONFIG"])
    root = Path(os.environ["MANAGERAI_REPORT_STATE_DIR"])
    if not config.is_absolute() or not root.is_absolute():
        raise ValueError("report_paths_must_be_absolute")
    os.umask(0o077)
    runtime = ReportRuntime(root, str(config))
    with ReportServer((bind, int(os.environ.get("MANAGERAI_REPORT_PORT", "13019"))), runtime, os.environ["MANAGERAI_REPORT_TOKEN"]) as server:
        runtime.recover_interrupted()
        server.serve_forever(poll_interval=0.5)


if __name__ == "__main__":
    main()
