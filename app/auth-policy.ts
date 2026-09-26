export const APP_AUTH_BASE_PATH = "/api/auth";

const REQUIRED_APP_AUTH_KEYS = [
  "AUTH_SECRET",
  "AUTH_GITHUB_ID",
  "AUTH_GITHUB_SECRET",
  "AUTH_OWNER_GITHUB_ID",
  "PUBLIC_PORTAL_ORIGIN",
] as const;

export type AppAuthEnvironment = Partial<
  Record<(typeof REQUIRED_APP_AUTH_KEYS)[number], string>
>;

export type AppAuthStatus =
  | { state: "disabled"; missing: [] }
  | { state: "misconfigured"; missing: string[] }
  | {
      state: "ready";
      missing: [];
      values: {
        secret: string;
        githubClientId: string;
        githubClientSecret: string;
        ownerGithubId: string;
        portalOrigin: string;
      };
    };

export function resolveAppAuthStatus(input: AppAuthEnvironment): AppAuthStatus {
  const configuredKeys = REQUIRED_APP_AUTH_KEYS.filter((key) => Boolean(input[key]?.trim()));
  if (configuredKeys.length === 0) return { state: "disabled", missing: [] };

  const missing = REQUIRED_APP_AUTH_KEYS.filter((key) => !input[key]?.trim());
  if (missing.length > 0) return { state: "misconfigured", missing: [...missing] };

  const secret = input.AUTH_SECRET!.trim();
  const githubClientId = input.AUTH_GITHUB_ID!.trim();
  const githubClientSecret = input.AUTH_GITHUB_SECRET!.trim();
  const ownerGithubId = input.AUTH_OWNER_GITHUB_ID!.trim();
  const portalOrigin = normalizedPortalOrigin(input.PUBLIC_PORTAL_ORIGIN!.trim());

  const invalid: string[] = [];
  if (secret.length < 32) invalid.push("AUTH_SECRET");
  if (githubClientId.length < 8) invalid.push("AUTH_GITHUB_ID");
  if (githubClientSecret.length < 20) invalid.push("AUTH_GITHUB_SECRET");
  if (!/^[1-9][0-9]{0,19}$/.test(ownerGithubId)) invalid.push("AUTH_OWNER_GITHUB_ID");
  if (!portalOrigin) invalid.push("PUBLIC_PORTAL_ORIGIN");
  if (invalid.length > 0) return { state: "misconfigured", missing: invalid };

  return {
    state: "ready",
    missing: [],
    values: { secret, githubClientId, githubClientSecret, ownerGithubId, portalOrigin: portalOrigin! },
  };
}

export function isAllowedGithubIdentity(
  provider: string | undefined,
  providerAccountId: string | undefined,
  ownerGithubId: string,
): boolean {
  return provider === "github" && providerAccountId === ownerGithubId;
}

export function safeReturnTo(value: string): string {
  if (!value.startsWith("/") || hasUnsafeEncoding(value)) return "/";

  let candidate = value;
  for (let pass = 0; pass < 2; pass += 1) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      return "/";
    }
    if (hasUnsafeDecodedValue(candidate)) return "/";
    try {
      if (isAuthLoop(new URL(candidate, "https://managerai.invalid").pathname)) return "/";
    } catch {
      return "/";
    }
  }

  let url: URL;
  try {
    url = new URL(value, "https://managerai.invalid");
  } catch {
    return "/";
  }
  if (url.origin !== "https://managerai.invalid") return "/";
  if (isAuthLoop(url.pathname)) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}

function normalizedPortalOrigin(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const localDevelopment = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !localDevelopment) return null;
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

function hasUnsafeEncoding(value: string): boolean {
  return /[\\\u0000-\u001f\u007f]/.test(value) || /%(?:00|0a|0d|2f|5c|25)/i.test(value);
}

function hasUnsafeDecodedValue(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return true;
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return true;
  const path = value.split(/[?#]/, 1)[0];
  return path.split("/").some((segment) => segment === "." || segment === "..");
}

function isAuthLoop(pathname: string): boolean {
  return pathname === "/auth" || pathname.startsWith("/auth/") || pathname === APP_AUTH_BASE_PATH || pathname.startsWith(`${APP_AUTH_BASE_PATH}/`);
}
