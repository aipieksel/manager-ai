import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const template = await readFile(resolve(root, "runtime/installer.template.sh"), "utf8");
const files = [
  ["runtime/review-report.py", "/opt/agent-command-center/review-report.py", "0755"],
  ["runtime/reports.py", "/opt/agent-command-center/reports.py", "0644"],
  ["runtime/report_package.py", "/opt/agent-command-center/report_package.py", "0644"],
  ["runtime/runner.py", "/opt/agent-command-center/runner.py", "0755"],
  ["runtime/agent-command-center-runner.service", "/etc/systemd/system/agent-command-center-runner.service", "0644"],
  ["runtime/jobs/preflight.sh", "/opt/agent-command-center/jobs/preflight.sh", "0755"],
  ["runtime/jobs/install-dependencies.sh", "/opt/agent-command-center/jobs/install-dependencies.sh", "0755"],
  ["runtime/jobs/install-codex.sh", "/opt/agent-command-center/jobs/install-codex.sh", "0755"],
  ["runtime/jobs/verify-codex.sh", "/opt/agent-command-center/jobs/verify-codex.sh", "0755"],
  ["runtime/jobs/prepare-manager.sh", "/opt/agent-command-center/jobs/prepare-manager.sh", "0755"],
  ["runtime/jobs/health-check.sh", "/opt/agent-command-center/jobs/health-check.sh", "0755"],
];

const embedded = [];
for (const [source, target, mode] of files) {
  const bytes = await readFile(resolve(root, source));
  embedded.push(`install -d -m 0755 ${dirname(target)}`);
  embedded.push(`printf '%s' '${bytes.toString("base64")}' | base64 -d > ${target}`);
  embedded.push(`chmod ${mode} ${target}`);
}

const output = template.replace("__EMBEDDED_FILES__", embedded.join("\n"));
const target = resolve(root, "public/setup/agent-command-center-bootstrap.sh");
await mkdir(dirname(target), { recursive: true });
await writeFile(target, output, { mode: 0o644 });
