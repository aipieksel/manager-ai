import { Auth, type AuthConfig } from "@auth/core";
import { getToken } from "@auth/core/jwt";
import GitHub from "@auth/core/providers/github";
import { env } from "cloudflare:workers";
import {
  APP_AUTH_BASE_PATH,
  isAllowedGithubIdentity,
  resolveAppAuthStatus,
  safeReturnTo,
  type AppAuthEnvironment,
} from "./auth-policy";

export type AppSessionUser = {
  displayName: string;
  email: string;
  fullName: string | null;
  subject: string;
  authMode: "github";
  signOutPath: string;
};

export function currentAppAuthStatus() {
  return resolveAppAuthStatus(env as unknown as AppAuthEnvironment);
}

export async function handleAppAuthRequest(request: Request): Promise<Response> {
  const status = currentAppAuthStatus();
  if (status.state !== "ready") {
    return authErrorResponse(status.state === "disabled" ? 404 : 503);
  }

  try {
    const response = await Auth(await canonicalAuthRequest(request, status.values.portalOrigin), authConfig(status.values));
    return hardenAuthResponse(response);
  } catch (error) {
    console.error("[managerai-auth] request failed", error instanceof Error ? error.name : "AuthError");
    return authErrorResponse(500);
  }
}

export async function getAppSessionUser(requestHeaders: Headers): Promise<AppSessionUser | null> {
  const status = currentAppAuthStatus();
  if (status.state !== "ready") return null;

  const secureCookie = status.values.portalOrigin.startsWith("https://");
  const sessionHeaders = new Headers(requestHeaders);
  sessionHeaders.delete("authorization");
  const token = await getToken({
    req: { headers: sessionHeaders },
    secret: status.values.secret,
    secureCookie,
  });
  const subject = token?.sub;
  if (!subject || subject !== status.values.ownerGithubId) return null;

  const email = token.email?.trim() || `github:${subject}`;
  const fullName = token.name?.trim() || null;
  return {
    displayName: fullName ?? email,
    email,
    fullName,
    subject: `github:${subject}`,
    authMode: "github",
    signOutPath: appSignOutPath("/"),
  };
}

export function appSignInPath(returnTo: string): string {
  return `${APP_AUTH_BASE_PATH}/signin?callbackUrl=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

export function appSignOutPath(returnTo = "/"): string {
  return `${APP_AUTH_BASE_PATH}/signout?callbackUrl=${encodeURIComponent(safeReturnTo(returnTo))}`;
}

function authConfig(values: Extract<ReturnType<typeof resolveAppAuthStatus>, { state: "ready" }>["values"]): AuthConfig {
  return {
    basePath: APP_AUTH_BASE_PATH,
    secret: values.secret,
    trustHost: true,
    useSecureCookies: values.portalOrigin.startsWith("https://"),
    session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
    providers: [
      GitHub({
        clientId: values.githubClientId,
        clientSecret: values.githubClientSecret,
        checks: ["pkce", "state"],
      }),
    ],
    pages: { error: "/auth/error" },
    callbacks: {
      async signIn({ account }) {
        return isAllowedGithubIdentity(account?.provider, account?.providerAccountId, values.ownerGithubId);
      },
      async jwt({ token, account }) {
        if (account?.provider === "github" && account.providerAccountId) token.sub = account.providerAccountId;
        return token;
      },
      async session({ session, token }) {
        if (session.user && token.sub) (session.user as typeof session.user & { id: string }).id = token.sub;
        return session;
      },
      async redirect({ url, baseUrl }) {
        const parsedBase = new URL(baseUrl);
        let returnTo = url;
        try {
          const candidate = new URL(url, parsedBase);
          if (candidate.origin !== parsedBase.origin) return parsedBase.origin;
          returnTo = `${candidate.pathname}${candidate.search}${candidate.hash}`;
        } catch {
          return parsedBase.origin;
        }
        return `${parsedBase.origin}${safeReturnTo(returnTo)}`;
      },
    },
    logger: {
      error(error) {
        console.error("[managerai-auth]", error.name);
      },
      warn(code) {
        console.warn("[managerai-auth]", code);
      },
      debug() {},
    },
  };
}

async function canonicalAuthRequest(request: Request, portalOrigin: string): Promise<Request> {
  const incoming = new URL(request.url);
  const canonical = new URL(`${incoming.pathname}${incoming.search}`, portalOrigin);
  sanitizeCallbackParameter(canonical.searchParams, portalOrigin);

  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (request.method === "POST" && contentType.startsWith("application/x-www-form-urlencoded")) {
    const body = new URLSearchParams(await request.clone().text());
    sanitizeCallbackParameter(body, portalOrigin);
    return new Request(canonical, { method: request.method, headers: request.headers, body });
  }
  return new Request(canonical, request);
}

function sanitizeCallbackParameter(parameters: URLSearchParams, portalOrigin: string) {
  const callbackUrl = parameters.get("callbackUrl");
  if (callbackUrl === null) return;

  let returnTo = callbackUrl;
  try {
    const parsed = new URL(callbackUrl, portalOrigin);
    returnTo = parsed.origin === portalOrigin ? `${parsed.pathname}${parsed.search}${parsed.hash}` : "/";
  } catch {
    returnTo = "/";
  }
  parameters.set("callbackUrl", `${portalOrigin}${safeReturnTo(returnTo)}`);
}

function hardenAuthResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-frame-options", "DENY");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function authErrorResponse(status: number): Response {
  return new Response("Authentication is unavailable.", {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}
