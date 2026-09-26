# Portable helpers for macOS and GNU/Linux. Source this file; do not execute it.

posix_sha256() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${file}" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${file}" | awk '{print $1}'
  else
    echo "posix_sha256 requires sha256sum or shasum." >&2
    return 69
  fi
}

posix_flock_nb() {
  local fd="$1"
  if command -v flock >/dev/null 2>&1; then
    flock -n "${fd}"
    return
  fi
  python3 - "${fd}" <<'PY'
import fcntl, sys
fcntl.flock(int(sys.argv[1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
PY
}

posix_timeout() {
  local duration="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout --signal=TERM --kill-after="${SITES_BUILD_KILL_AFTER:-10s}" "${duration}" "$@"
    return
  fi
  if command -v gtimeout >/dev/null 2>&1; then
    gtimeout --signal=TERM --kill-after="${SITES_BUILD_KILL_AFTER:-10s}" "${duration}" "$@"
    return
  fi
  SITES_BUILD_KILL_AFTER="${SITES_BUILD_KILL_AFTER:-10s}" python3 - "${duration}" "$@" <<'PY'
import os, signal, subprocess, sys

def parse_duration(value):
    text = str(value).strip().lower()
    if text.endswith("ms"):
        return float(text[:-2]) / 1000.0
    if text.endswith("s"):
        return float(text[:-1])
    if text.endswith("m"):
        return float(text[:-1]) * 60.0
    if text.endswith("h"):
        return float(text[:-1]) * 3600.0
    return float(text)

duration = parse_duration(sys.argv[1])
kill_after = parse_duration(os.environ.get("SITES_BUILD_KILL_AFTER", "10s"))
command = sys.argv[2:]
process = subprocess.Popen(command)
try:
    returncode = process.wait(timeout=duration)
except subprocess.TimeoutExpired:
    process.send_signal(signal.SIGTERM)
    try:
        process.wait(timeout=kill_after)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    raise SystemExit(124)
raise SystemExit(returncode or 0)
PY
}
