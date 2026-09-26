"""Fixed report runtime. Requires a deployment-owned executor and OS sandbox.

HTTP callers supply only identifiers and pinned configuration references. The
registered executor path, reference and source paths never come from a request.
"""
from __future__ import annotations
import fcntl
import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import threading
import shutil
import time
import uuid
import zipfile
from datetime import datetime, timezone
from report_package import verify_package

ID = re.compile(r"^[A-Za-z0-9_-]{1,180}$")


def configuration_digest(config):
    bound = {k: v for k, v in config.items() if k not in {"enabled", "preflightRunId"}}
    return hashlib.sha256(json.dumps(bound, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class ReportRuntime:
    def __init__(self, root, configuration, notify=lambda _: None):
        self.root = Path(root)
        self.configuration = configuration
        self.notify = notify
        self.mutex = threading.Lock()
        self.reviewing = set()

    def config(self):
        path = Path(self.configuration)
        if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
            raise ValueError("report_configuration_unavailable")
        config = json.loads(path.read_text())
        if config.get("enabled") is not True:
            raise ValueError("report_disabled")
        # Sandbox argv is fixed by this implementation. No caller-selected
        # executable, environment, working directory, host or shell arguments.
        engine = config.get("engine", "artifact-tool")
        if engine not in {"artifact-tool", "openpyxl-libreoffice"}: raise ValueError("report_dependency_unavailable")
        dependencies = ("executor", "sandbox", "reference", "ga4Directory", "firstPartyDirectory") + (("python",) if engine == "openpyxl-libreoffice" else ("node", "engineModules"))
        for name in dependencies:
            value = Path(config[name])
            if not value.is_absolute() or value.resolve() != value or not value.exists():
                raise ValueError("report_dependency_unavailable")
        if Path(config["sandbox"]).name != "bwrap":
            raise ValueError("report_sandbox_unavailable")
        executable = config["python"] if engine == "openpyxl-libreoffice" else config["node"]
        if not str(executable).startswith("/usr/") or len(config.get("reviewSecret", "")) < 32:
            raise ValueError("report_dependency_unavailable")
        for name, expected in config.get("executorHashes", {}).items():
            if Path(name).name != name: raise ValueError("report_dependency_unavailable")
            file = Path(config["executor"]).parent / name
            if file.is_symlink() or hashlib.sha256(file.read_bytes()).hexdigest() != expected: raise ValueError("report_executor_changed")
        return config

    def directory(self, run_id):
        if not isinstance(run_id, str) or not ID.fullmatch(run_id):
            raise ValueError("invalid_report_identity")
        target = self.root / run_id
        if self.root.resolve() != self.root or target.is_symlink():
            raise ValueError("unsafe_report_path")
        return target

    def state(self, run_id):
        target = self.directory(run_id) / "state.json"
        if not target.exists():
            return None
        if target.is_symlink():
            raise ValueError("unsafe_report_path")
        return json.loads(target.read_text())

    def write(self, run_id, value):
        root = self.directory(run_id)
        temporary = root / f".state-{uuid.uuid4().hex}"
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as file:
            json.dump(value, file, separators=(",", ":")); file.flush(); os.fsync(file.fileno())
        os.replace(temporary, root / "state.json")
        fd = os.open(root, os.O_RDONLY)
        try: os.fsync(fd)
        finally: os.close(fd)

    def accept(self, payload):
        if not self.root.is_absolute() or self.root.resolve() != self.root:
            raise ValueError("unsafe_report_path")
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        admission = os.open(self.root / "admission.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        try:
            try:
                fcntl.flock(admission, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise ValueError("report_runtime_at_capacity")
            return self._accept_locked(payload)
        finally:
            os.close(admission)

    def _accept_locked(self, payload):
        fields = {"schemaVersion", "action", "runId", "attempt", "projectId", "configRevision", "referenceId", "referenceSha256", "sourceConfigId"}
        if not isinstance(payload, dict) or set(payload) != fields or payload["schemaVersion"] != 1 or payload["action"] != "generate_ai_referral_report" or type(payload["attempt"]) is not int or payload["attempt"] != 1:
            raise ValueError("invalid_report_request")
        config = self.config()
        for request_key, config_key in [("projectId", "projectId"), ("configRevision", "revision"), ("referenceId", "referenceId"), ("referenceSha256", "referenceSha256"), ("sourceConfigId", "sourceConfigId")]:
            if payload[request_key] != config[config_key]:
                raise ValueError("report_configuration_conflict")
        run_id = payload["runId"]
        root = self.directory(run_id)
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        digest = hashlib.sha256(encoded).hexdigest()
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        if len(list(self.root.iterdir())) > 1000 or shutil.disk_usage(self.root).free < 512 * 1024 * 1024:
            raise ValueError("report_storage_capacity")
        with self.mutex:
            root.mkdir(mode=0o700, exist_ok=True)
            fd = os.open(root / "execution.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                os.close(fd)
                existing = self.state(run_id)
                if existing and existing.get("requestHash") == digest:
                    return existing
                raise ValueError("report_execution_active")
            existing = self.state(run_id)
            if existing:
                os.close(fd)
                if existing.get("requestHash") != digest:
                    raise ValueError("report_idempotency_conflict")
                # Acquiring the inherited process lock proves the old executor
                # no longer holds it. Preserve a terminal interruption, not a
                # guessed success or an automatic analytics regeneration.
                if existing.get("status") in {"queued", "running"}:
                    existing = {**existing, "status": "failed", "errorCode": "report_execution_interrupted", "sequence": existing.get("sequence", 1) + 1}
                    self.write(run_id, existing)
                return existing
            self.recover_interrupted()
            active = sum(1 for p in self.root.glob("*/state.json") if json.loads(p.read_text()).get("status") in {"queued", "running"})
            if active >= 1:
                os.close(fd); raise ValueError("report_runtime_at_capacity")
            state = dict(runId=run_id, attempt=1, requestHash=digest, configurationDigest=configuration_digest(config), status="queued", stage="preflight", sequence=1)
            self.write(run_id, state)
            thread = threading.Thread(target=self.execute, args=(config, payload, state, fd), daemon=True)
            thread.start()
            return state

    def recover_interrupted(self):
        for file in self.root.glob("*/state.json"):
            run_id = file.parent.name
            if file.is_symlink() or file.parent.is_symlink(): continue
            state = self.state(run_id)
            if state.get("status") not in {"queued", "running"}: continue
            fd = os.open(file.parent / "execution.lock", os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
            try:
                try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError: continue
                latest = self.state(run_id)
                if latest.get("status") in {"queued", "running"}:
                    self.write(run_id, {**latest, "status": "failed", "errorCode": "report_execution_interrupted", "sequence": latest["sequence"]+1})
            finally: os.close(fd)

    def execute(self, config, payload, state, lock_fd):
        run_id = payload["runId"]
        root = self.directory(run_id) / "work"
        try:
            root.mkdir(mode=0o700, exist_ok=False)
            if config.get("sourceConfiguration"):
                adapter = Path(config["executor"]).parent / ("refresh_sources.py" if config.get("sourceMode") == "https-refresh" else "acquire.py")
                if adapter.is_symlink() or hashlib.sha256(adapter.read_bytes()).hexdigest() != config.get("sourceAdapterSha256"):
                    raise ValueError("report_source_adapter_changed")
                source_root = self.directory(run_id) / "snapshots"
                acquired = subprocess.run([sys.executable, str(adapter), "--config", config["sourceConfiguration"], "--output", str(source_root)],
                    stdin=subprocess.DEVNULL, capture_output=True, timeout=600, env={"PATH":"/usr/bin:/bin", "LANG":"C.UTF-8"}, pass_fds=(lock_fd,))
                if acquired.returncode or len(acquired.stdout)>4096: raise ValueError("report_source_acquisition_failed")
                paths = json.loads(acquired.stdout)
                for key, expected in (("ga4Directory", "ga4"), ("firstPartyDirectory", "firstParty")):
                    if paths.get(key) != str(source_root/expected): raise ValueError("report_source_scope_mismatch")
                config = {**config, **paths}
            # The dedicated filesystem view is read-only except this job. No
            # network, production writes, sibling artifacts or generic shell.
            job = {**payload, "reference": "/reference.xlsx", "ga4Directory": "/ga4", "firstPartyDirectory": "/first-party", "outputDirectory": "/job", "sourceMetadata": config["sourceMetadata"]}
            job_path = root / "job.json"
            job_path.write_text(json.dumps(job)); job_path.chmod(0o600)
            state = {**state, "status": "running", "stage": "build", "sequence": 2}
            self.write(run_id, state); self.notify(state)
            production = config.get("engine") == "openpyxl-libreoffice"
            engine_mounts = ["--ro-bind", "/etc/libreoffice", "/etc/libreoffice", "--ro-bind", "/etc/fonts", "/etc/fonts", "--ro-bind-try", "/var/cache/fontconfig", "/var/cache/fontconfig"] if production else ["--ro-bind", config["engineModules"], "/node_modules"]
            executable = config["python"] if production else config["node"]
            command = [config["sandbox"], "--die-with-parent", "--unshare-all", "--new-session", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "--ro-bind", "/lib", "/lib", "--ro-bind-try", "/lib64", "/lib64", *engine_mounts, "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--ro-bind", config["reference"], "/reference.xlsx", "--ro-bind", config["ga4Directory"], "/ga4", "--ro-bind", config["firstPartyDirectory"], "/first-party", "--ro-bind", str(Path(config["executor"]).parent), "/executor", "--bind", str(root), "/job", "--chdir", "/job", executable, "/executor/" + Path(config["executor"]).name, "--job", "/job/job.json"]
            # A small guardian retains the inherited process fence while Bubblewrap
            # runs. Bubblewrap closes unrelated descriptors; its parent-death
            # option kills generation if the guardian is terminated.
            launcher = "import subprocess,sys; sys.exit(subprocess.run(sys.argv[2:],close_fds=True).returncode)"
            result = subprocess.run([sys.executable, "-c", launcher, str(lock_fd), *command], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=min(max(config.get("timeoutSeconds", 600), 30), 1800), env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "HOME": "/tmp", "SAL_USE_VCLPLUGIN": "svp"}, pass_fds=(lock_fd,))
            if result.returncode:
                raise ValueError("report_executor_failed")
            # Generation finishes before independent review. Polling may later
            # finalize the exact candidate; no rebuild is needed while waiting.
            candidate_path = root / "candidate.json"
            if candidate_path.is_symlink() or not candidate_path.is_file():
                raise ValueError("workbook_candidate_missing")
            candidate = json.loads(candidate_path.read_text())
            if candidate.get("runId") != run_id:
                raise ValueError("invalid_report_artifact")
            state = {**state, "status": "waiting_for_review", "stage": "visual_review", "sequence": 3}
        except subprocess.TimeoutExpired:
            state = {**state, "status": "timed_out", "errorCode": "job_timed_out", "sequence": 3}
        except Exception as error:
            code = str(error) if isinstance(error, ValueError) and str(error).startswith(("report_", "invalid_report_", "workbook_")) else "report_executor_failed"
            state = {**state, "status": "failed", "errorCode": code, "sequence": 3}
        finally:
            try:
                self.write(run_id, state); self.notify(state)
            finally: os.close(lock_fd)
        if state.get("status") == "waiting_for_review": self.schedule_review(run_id)

    def schedule_review(self, run_id):
        config = self.config()
        codex = config.get("reviewCodex")
        if not codex: return
        with self.mutex:
            if run_id in self.reviewing: return
            self.reviewing.add(run_id)
        def work():
            try:
                from report_review import assess
                result = assess(self, run_id, codex, timeout=300)
                if result.get("status") == "passed": self.finalize(run_id)
            finally:
                with self.mutex: self.reviewing.discard(run_id)
        threading.Thread(target=work, daemon=True).start()

    def finalize(self, run_id):
        state = self.state(run_id)
        if not state or state.get("status") != "waiting_for_review":
            return state
        root = self.directory(run_id)
        fd = os.open(root / "execution.lock", os.O_RDWR | os.O_NOFOLLOW)
        try:
            try: fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError: return state
            state = self.state(run_id)
            if state.get("status") != "waiting_for_review": return state
            config = self.config()
            if state.get("configurationDigest") != configuration_digest(config): raise ValueError("report_configuration_conflict")
            evidence_root = Path(config["reviewEvidenceDirectory"])
            evidence_file = evidence_root / f"{run_id}.json"
            if not evidence_root.is_absolute() or evidence_root.resolve() != evidence_root or evidence_file.is_symlink():
                raise ValueError("workbook_review_unavailable")
            if not evidence_file.exists(): return state
            work = root / "work"
            if work.is_symlink(): raise ValueError("unsafe_report_path")
            def read_private(name):
                file = work / name
                if file.is_symlink() or not file.is_file(): raise ValueError("invalid_report_artifact")
                return json.loads(file.read_text())
            job = read_private("job.json")
            for key in ("projectId", "referenceId", "referenceSha256", "sourceConfigId"):
                if job[key] != config[key]: raise ValueError("report_configuration_conflict")
            if job["configRevision"] != config["revision"]: raise ValueError("report_configuration_conflict")
            candidate = read_private("candidate.json")
            if candidate.get("runId") != run_id: raise ValueError("report_run_identity_conflict")
            normalized = read_private("normalized.json")
            artifact = candidate["artifact"]
            filename = artifact["filename"]
            if Path(filename).name != filename or not filename.endswith(".xlsx") or not ID.fullmatch(artifact["artifactId"]):
                raise ValueError("invalid_report_artifact")
            file = work / filename
            if file.is_symlink() or not file.is_file() or file.stat().st_size > 25 * 1024 * 1024:
                raise ValueError("invalid_report_artifact")
            data = file.read_bytes()
            if len(data) != artifact["byteLength"] or hashlib.sha256(data).hexdigest() != artifact["sha256"]:
                raise ValueError("invalid_report_artifact")
            verify_package(data, candidate["metrics"])
            receipt = json.loads(evidence_file.read_text())
            review = receipt["review"]
            encoded = json.dumps(review, sort_keys=True, separators=(",", ":")).encode()
            signature = hmac.new(config["reviewSecret"].encode(), encoded, hashlib.sha256).hexdigest()
            if not hmac.compare_digest(signature, receipt.get("signature", "")) or review.get("runId") != run_id or review.get("sha256") != artifact["sha256"] or review.get("status") != "passed" or review.get("sheets") != ["Summary", "GA4 Detail", "GA4 Daily", "GA4 Pages", "First-Party Detail", "Methodology"] or not ID.fullmatch(review.get("evidenceId", "")):
                raise ValueError("workbook_review_unavailable")
            warnings = normalized.get("warnings", [])
            if any(c["coverageStatus"] != "complete" or c["missingIntervals"] for c in candidate["sourceCoverage"].values()):
                warnings = [*warnings, {"code": "coverage_gap", "source": "report", "message": "Source coverage contains gaps; see Methodology."}]
            report = dict(schemaVersion=1, reportKey="site.ai_referrals", runId=run_id,
                generatedAt=datetime.now(timezone.utc).isoformat(), quality="complete" if not warnings else "with_warnings",
                sourceCoverage=candidate["sourceCoverage"], metrics=candidate["metrics"], warnings=warnings, artifact=artifact,
                provenance=dict(referenceArtifactId=config["referenceId"], referenceSha256=config["referenceSha256"],
                    skillCommit=config["skillCommit"], reportCodeCommit=config["reportCodeCommit"],
                    ga4SnapshotSha256=normalized["snapshotHashes"]["ga4"], firstPartySnapshotSha256=normalized["snapshotHashes"]["firstParty"]),
                validation=dict(totalsReconciled=True, formulaErrorCount=0, packageIntegrity=True, visualReview="passed", visualEvidenceRef=review["evidenceId"]))
            file.chmod(0o400)
            state = {**state, "status": "succeeded", "stage": "artifact_ready", "sequence": state["sequence"]+1, "result": report}
            self.write(run_id, state)
            return state
        finally:
            os.close(fd)

    def preflight(self):
        config = self.config()
        run_id = config.get("preflightRunId", "")
        state = self.state(run_id)
        if not state or state.get("status") != "succeeded": raise ValueError("report_preflight_required")
        if state.get("configurationDigest") != configuration_digest(config): raise ValueError("report_preflight_required")
        job_path = self.directory(run_id) / "work" / "job.json"
        if job_path.is_symlink() or job_path.parent.is_symlink(): raise ValueError("report_preflight_required")
        job = json.loads(job_path.read_text())
        for key in ("projectId", "referenceId", "referenceSha256", "sourceConfigId"):
            if job[key] != config[key]: raise ValueError("report_preflight_required")
        if job["configRevision"] != config["revision"]: raise ValueError("report_preflight_required")
        report = state["result"]
        verified_at = int(datetime.fromisoformat(report["generatedAt"].replace("Z", "+00:00")).timestamp()*1000)
        if verified_at > int(time.time()*1000): raise ValueError("report_preflight_invalid")
        self.evidence(run_id, report["validation"]["visualEvidenceRef"])
        self.artifact(run_id, report["artifact"]["artifactId"])
        if hashlib.sha256(Path(config["reference"]).read_bytes()).hexdigest()!=config["referenceSha256"]:
            raise ValueError("report_reference_changed")
        return {**{key: config[key] for key in ("projectId", "revision", "referenceId", "referenceSha256", "sourceConfigId", "executorId", "executorVersionId", "apiAppId", "installationId")}, "verifiedAt":int(time.time()*1000), "reviewedAt":verified_at, "verified":True}

    def evidence(self, run_id, evidence_id):
        state = self.state(run_id)
        if not state or state.get("status") != "succeeded": raise ValueError("workbook_review_unavailable")
        config = self.config()
        root = Path(config["reviewEvidenceDirectory"])
        file = root / f"{run_id}.json"
        if root.resolve() != root or file.is_symlink(): raise ValueError("workbook_review_unavailable")
        receipt = json.loads(file.read_text()); review = receipt["review"]
        signature = hmac.new(config["reviewSecret"].encode(), json.dumps(review, sort_keys=True, separators=(",", ":")).encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(signature, receipt.get("signature", "")) or review.get("evidenceId") != evidence_id or review.get("runId") != run_id or review.get("status") != "passed" or review.get("sha256") != state["result"]["artifact"]["sha256"]:
            raise ValueError("workbook_review_unavailable")
        return {"verified": True, "sha256": review["sha256"]}

    def artifact(self, run_id, artifact_id):
        state = self.state(run_id)
        if not state or state.get("status") != "succeeded":
            raise ValueError("report_artifact_unavailable")
        meta = state["result"]["artifact"]
        if artifact_id != meta["artifactId"]:
            raise ValueError("report_artifact_unavailable")
        file = self.directory(run_id) / "work" / meta["filename"]
        if file.is_symlink() or file.parent.is_symlink():
            raise ValueError("unsafe_report_path")
        if file.stat().st_size > 25 * 1024 * 1024 or file.stat().st_size != meta["byteLength"]: raise ValueError("report_artifact_changed")
        data = file.read_bytes()
        if len(data) != meta["byteLength"] or hashlib.sha256(data).hexdigest() != meta["sha256"]:
            raise ValueError("report_artifact_changed")
        return meta, data
