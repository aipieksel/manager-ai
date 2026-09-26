import { env } from "cloudflare:workers";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { appSignInPath, currentAppAuthStatus, getAppSessionUser } from "./app-auth";
import { safeReturnTo } from "./auth-policy";

export type ChatGPTUser = {
  displayName: string;
  email: string;
  fullName: string | null;
  subject: string;
  authMode: "github" | "chatgpt" | "development";
  signOutPath: string;
};

const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";
const LOCAL_PROXY_SECRET_HEADER = "x-managerai-proxy-secret";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";
const SIGN_IN_PATH = "/signin-with-chatgpt";
const SIGN_OUT_PATH = "/signout-with-chatgpt";
const CALLBACK_PATH = "/callback";

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const requestHeaders = await headers();
  const appAuth = currentAppAuthStatus();
  if (appAuth.state === "ready") return getAppSessionUser(new Headers(requestHeaders));
  if (appAuth.state === "misconfigured") return null;

  const email = trustedProxyIdentity(
    requestHeaders.get(USER_EMAIL_HEADER),
    requestHeaders.get(LOCAL_PROXY_SECRET_HEADER),
  );
  if (!email) return localDevelopmentUser();

  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const fullName =
    encodedFullName &&
    requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
      ? safeDecodeURIComponent(encodedFullName)
      : null;

  return {
    displayName: fullName ?? email,
    email,
    fullName,
    subject: `email:${email.trim().toLowerCase()}`,
    authMode: "chatgpt",
    signOutPath: chatGPTSignOutPath("/"),
  };
}

function trustedProxyIdentity(email: string | null, suppliedSecret: string | null): string | null {
  const expectedSecret = (env as unknown as { LOCAL_PROXY_SECRET?: string }).LOCAL_PROXY_SECRET;
  if (!expectedSecret) return email;
  if (!email || !suppliedSecret || !timingSafeEqual(suppliedSecret, expectedSecret)) return null;
  return email;
}

function timingSafeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

function localDevelopmentUser(): ChatGPTUser | null {
  if (!import.meta.env.DEV) return null;

  const localEnv = env as unknown as {
    LOCAL_DEV_USER_EMAIL?: string;
    LOCAL_DEV_USER_FULL_NAME?: string;
  };
  const email = localEnv.LOCAL_DEV_USER_EMAIL?.trim();
  if (!email) return null;

  const fullName = localEnv.LOCAL_DEV_USER_FULL_NAME?.trim() || null;
  return {
    displayName: fullName ?? email,
    email,
    fullName,
    subject: `development:${email.trim().toLowerCase()}`,
    authMode: "development",
    signOutPath: chatGPTSignOutPath("/"),
  };
}

export async function requireChatGPTUser(
  returnTo: string,
): Promise<ChatGPTUser> {
  const user = await getChatGPTUser();
  if (user) return user;

  const appAuth = currentAppAuthStatus();
  redirect(appAuth.state === "ready" ? appSignInPath(returnTo) : appAuth.state === "misconfigured" ? "/auth/error" : chatGPTSignInPath(returnTo));
}

export function chatGPTSignInPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

function safeRelativeReturnPath(value: string): string {
  const safe = safeReturnTo(value);
  return isReservedAuthPath(new URL(safe, "https://app.local").pathname) ? "/" : safe;
}

function isReservedAuthPath(pathname: string): boolean {
  return (
    pathname === SIGN_IN_PATH ||
    pathname === SIGN_OUT_PATH ||
    pathname === CALLBACK_PATH
  );
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
