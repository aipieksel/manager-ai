import { requireOwnerApi, runtimeEnv, secureJson } from "../../../server-security";
import { currentAppAuthStatus } from "../../../app-auth";
import { getRunnerConfiguration } from "../../../setup-server";

export async function GET() {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;

  const values = runtimeEnv();
  const appAuth = currentAppAuthStatus();
  const runner = await getRunnerConfiguration();
  const managerUrlConfigured = Boolean(values.MANAGER_RUNTIME_URL || runner.url);
  const managerTokenConfigured = Boolean(values.MANAGER_RUNTIME_TOKEN || runner.token);

  return secureJson({
    portal: {
      authenticated: true,
      ownerAllowlistConfigured: appAuth.state === "ready" || Boolean(values.OWNER_EMAIL),
      persistenceConfigured: true,
      access: "owner-only",
      method: owner.authMode === "github" ? "github-oauth" : "trusted-host-identity",
    },
    managerRuntime: {
      configured: managerUrlConfigured && managerTokenConfigured,
      urlConfigured: managerUrlConfigured,
      tokenConfigured: managerTokenConfigured,
      source: values.MANAGER_RUNTIME_URL && values.MANAGER_RUNTIME_TOKEN ? "dedicated" : runner.configured ? "setup-runner" : "none",
    },
    webhook: {
      handlerBuilt: true,
      secretConfigured: Boolean(values.AGENT_WEBHOOK_SECRET),
      externallyReachable: Boolean(values.MANAGERAI_INTAKE_STATUS_URL && values.MANAGERAI_INTAKE_STATUS_TOKEN),
      reason: values.MANAGERAI_INTAKE_STATUS_URL && values.MANAGERAI_INTAKE_STATUS_TOKEN ? "Dedicated intake gateway configured." : "Dedicated intake gateway is not configured.",
    },
    mcp: {
      configured: managerUrlConfigured && managerTokenConfigured,
      reason: managerUrlConfigured && managerTokenConfigured
        ? "The manager runtime is connected, but no MCP clients are configured."
        : "MCP clients belong on the external manager runtime; no runtime is connected yet.",
    },
  });
}
