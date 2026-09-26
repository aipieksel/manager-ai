#!/usr/bin/env python3
"""Fixed-workspace Codex runner used through the ManagerAI SSH transport."""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
from pathlib import Path

MAX_BODY = 96 * 1024
ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,180}$")
ALLOWED_CHECKOUT = Path(os.environ.get("MANAGERAI_REMOTE_CHECKOUT", "/var/www/staging.website.com/site"))


def parse_thread_id(output: str) -> str:
    for line in output.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        value = event.get("thread_id") or event.get("threadId") if isinstance(event, dict) else None
        if isinstance(value, str) and ID_PATTERN.fullmatch(value):
            return value
    return ""


def main() -> int:
    raw = os.read(0, MAX_BODY + 1)
    if not raw or len(raw) > MAX_BODY:
        raise SystemExit("Invalid request size")
    request = json.loads(raw)
    checkout = Path(str(request.get("checkoutPath", "")))
    if checkout != ALLOWED_CHECKOUT or not (checkout / ".git").is_dir():
        raise SystemExit("Workspace is not allowlisted")
    thread_id = str(request.get("threadId") or "")
    if thread_id and not ID_PATTERN.fullmatch(thread_id):
        raise SystemExit("Invalid thread id")
    sandbox = str(request.get("sandboxMode", "read-only"))
    if sandbox not in {"read-only", "workspace-write"}:
        sandbox = "read-only"
    reasoning = str(request.get("reasoningEffort", "high"))
    if reasoning not in {"low", "medium", "high", "xhigh"}:
        reasoning = "high"
    model = str(request.get("modelName", "default"))
    prompt = str(request.get("prompt", ""))[:70_000]
    if not prompt:
        raise SystemExit("Prompt is required")
    state = Path.home() / ".local/share/managerai-remote-runner"
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with tempfile.NamedTemporaryFile(prefix="response-", dir=state, delete=False) as handle:
        output_file = Path(handle.name)
    try:
        command = ["codex", "exec"]
        if thread_id:
            command += ["resume", "-c", 'approval_policy="never"', "-c", f'model_reasoning_effort="{reasoning}"', "--json", "-o", str(output_file)]
            if model and model != "default":
                command += ["--model", model]
            command += [thread_id, prompt]
        else:
            command += ["--cd", str(checkout), "--sandbox", sandbox, "-c", 'approval_policy="never"', "-c", f'model_reasoning_effort="{reasoning}"', "--json", "-o", str(output_file)]
            if model and model != "default":
                command += ["--model", model]
            command.append(prompt)
        environment = {"HOME": str(Path.home()), "LANG": "C.UTF-8", "PATH": f"{Path.home()}/.local/bin:/usr/local/bin:/usr/bin:/bin", "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}"}
        result = subprocess.run(command, cwd=checkout, capture_output=True, text=True, timeout=7200, check=False, env=environment)
        response = output_file.read_text(encoding="utf-8")[:100_000] if output_file.exists() else ""
        print(json.dumps({"returnCode": result.returncode, "response": response.strip(), "threadId": parse_thread_id(result.stdout) or thread_id}, separators=(",", ":")))
        return 0
    finally:
        output_file.unlink(missing_ok=True)


if __name__ == "__main__":
    raise SystemExit(main())
