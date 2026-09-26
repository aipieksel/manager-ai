import { env } from "cloudflare:workers";
import { requireOwnerApi, runtimeEnv, secureJson } from "../../../server-security";

type AssetEnv = { ASSETS: Fetcher };

export async function GET(request: Request) {
  const owner = await requireOwnerApi();
  if (!owner.ok) return owner.response;
  const token = runtimeEnv().SETUP_RUNNER_TOKEN ?? "";
  if (token.length < 32) return secureJson({ error: "Bootstrap token is not configured" }, { status: 503 });

  const assetUrl = new URL("/setup/agent-command-center-bootstrap.sh", request.url);
  const asset = await (env as unknown as AssetEnv).ASSETS.fetch(new Request(assetUrl));
  if (!asset.ok) return secureJson({ error: "Bootstrap installer is unavailable" }, { status: 503 });
  const template = await asset.text();
  if (!template.includes("__ACC_RUNNER_TOKEN__")) return secureJson({ error: "Bootstrap installer is invalid" }, { status: 503 });
  const installer = template.replaceAll("__ACC_RUNNER_TOKEN__", token);
  return new Response(installer, {
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "content-disposition": "attachment; filename=agent-command-center-bootstrap.sh",
      "cache-control": "no-store, private",
      "content-security-policy": "default-src 'none'; sandbox",
      "x-content-type-options": "nosniff",
    },
  });
}
