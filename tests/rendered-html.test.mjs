import assert from "node:assert/strict";
import test from "node:test";
import { encode } from "@auth/core/jwt";

globalThis.__CLOUDFLARE_TEST_ENV__ = {
  OWNER_EMAIL: "owner@example.com",
  SETUP_RUNNER_TOKEN: "test-token-0123456789abcdef0123456789abcdef",
  ASSETS: {
    fetch: async (request) => new URL(request.url).pathname === "/setup/agent-command-center-bootstrap.sh"
      ? new Response("#!/bin/sh\nACC_RUNNER_TOKEN=__ACC_RUNNER_TOKEN__\n")
      : new Response("Not found", { status: 404 }),
  },
};

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

const runtime = {
  ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) },
};
const context = { waitUntil() {}, passThroughOnException() {} };

test("redirects an unauthenticated visitor to ChatGPT sign-in", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    runtime,
    context,
  );

  assert.equal(response.status, 307);
  assert.match(response.headers.get("location") ?? "", /\/signin-with-chatgpt\?/);
});

test("rewrites same-host redirects to the configured HTTPS portal origin", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://managerai.example.com/chat/assistant", { headers: { accept: "text/html" } }),
    { ...runtime, PUBLIC_PORTAL_ORIGIN: "https://managerai.example.com" },
    context,
  );

  assert.equal(response.status, 307);
  assert.match(response.headers.get("location") ?? "", /^https:\/\/managerai\.example\.com\//);
  assert.match(response.headers.get("location") ?? "", /return_to=%2Fchat%2Fassistant/);
});

test("requires the private proxy secret when local proxy mode is enabled", async () => {
  globalThis.__CLOUDFLARE_TEST_ENV__.LOCAL_PROXY_SECRET = "private-proxy-secret-0123456789";
  const worker = await loadWorker();

  const rejected = await worker.fetch(
    new Request("http://localhost/", {
      headers: {
        accept: "text/html",
        "oai-authenticated-user-email": "owner@example.com",
      },
    }),
    runtime,
    context,
  );
  assert.equal(rejected.status, 307);

  const accepted = await worker.fetch(
    new Request("http://localhost/", {
      headers: {
        accept: "text/html",
        "oai-authenticated-user-email": "owner@example.com",
        "x-managerai-proxy-secret": "private-proxy-secret-0123456789",
      },
    }),
    runtime,
    context,
  );
  assert.equal(accepted.status, 200);
  delete globalThis.__CLOUDFLARE_TEST_ENV__.LOCAL_PROXY_SECRET;
});

test("renders the owner control plane and documentation navigation", async () => {
  const worker = await loadWorker();

  const response = await worker.fetch(
    new Request("http://localhost/", {
      headers: {
        accept: "text/html",
        "oai-authenticated-user-email": "owner@example.com",
        "oai-authenticated-user-full-name": "Workspace%20Owner",
        "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
      },
    }),
    runtime,
    context,
  );

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") ?? "",
    /^text\/html\b/i,
  );
  const html = await response.text();
  assert.match(html, /Agent Command Center/i);
  assert.match(html, /Issue inbox/i);
  assert.match(html, /Documentation/i);
  assert.match(html, />Setup</i);
  assert.match(html, /runtime is not connected/i);
});

test("serves a personalized bootstrap installer only to the owner", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/setup/bootstrap", {
      headers: { "oai-authenticated-user-email": "owner@example.com" },
    }),
    runtime,
    context,
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") ?? "", /agent-command-center-bootstrap\.sh/);
  assert.doesNotMatch(await response.text(), /__ACC_RUNNER_TOKEN__/);
});

test("rejects cross-origin write requests before database access", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/tickets", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "oai-authenticated-user-email": "owner@example.com",
      },
      body: JSON.stringify({ title: "Should not be written" }),
    }),
    runtime,
    context,
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Cross-origin write rejected" });
});

test("rejects cross-origin project chat before runtime or database access", async () => {
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "oai-authenticated-user-email": "owner@example.com",
      },
      body: JSON.stringify({ projectId: "prj_vps_talkai", body: "Do work" }),
    }),
    runtime,
    context,
  );

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Cross-origin write rejected" });
});

test("accepts the configured public origin behind the private proxy", async () => {
  const authValues = {
    AUTH_SECRET: "a".repeat(32),
    AUTH_GITHUB_ID: "github-client-id",
    AUTH_GITHUB_SECRET: "g".repeat(40),
    AUTH_OWNER_GITHUB_ID: "12345678",
    PUBLIC_PORTAL_ORIGIN: "https://managerai.example.com",
  };
  Object.assign(globalThis.__CLOUDFLARE_TEST_ENV__, authValues);
  try {
    const cookieName = "__Secure-authjs.session-token";
    const ownerSession = await encode({
      token: { sub: "12345678", name: "Test Owner", email: "owner@example.com" },
      secret: authValues.AUTH_SECRET,
      salt: cookieName,
      maxAge: 3600,
    });
    const worker = await loadWorker();
    const response = await worker.fetch(
      new Request("http://172.17.0.1:13006/api/chat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          cookie: `${cookieName}=${ownerSession}`,
          origin: "https://managerai.example.com",
        },
        body: JSON.stringify({ projectId: "prj_vps_talkai", body: "Do work" }),
      }),
      runtime,
      context,
    );

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "Project agent runtime is not configured" });
  } finally {
    for (const key of Object.keys(authValues)) delete globalThis.__CLOUDFLARE_TEST_ENV__[key];
  }
});

test("rejects unsigned project-agent callbacks before database access", async () => {
  globalThis.__CLOUDFLARE_TEST_ENV__.PROJECT_AGENT_CALLBACK_SECRET = "callback-secret-0123456789abcdef0123456789";
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/runtime/project-callback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId: "run_test", conversationId: "cnv_test", projectSlug: "talkai", status: "succeeded" }),
    }),
    runtime,
    context,
  );

  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "Invalid signature" });
  delete globalThis.__CLOUDFLARE_TEST_ENV__.PROJECT_AGENT_CALLBACK_SECRET;
});

test("rejects unsigned external project-agent contact before database access", async () => {
  globalThis.__CLOUDFLARE_TEST_ENV__.AGENT_WEBHOOK_SECRET = "webhook-secret-0123456789abcdef0123456789";
  const worker = await loadWorker();
  const response = await worker.fetch(
    new Request("http://localhost/api/webhooks/intake", {
      method: "POST",
      headers: { "content-type": "application/json", "x-agent-id": "external-test" },
      body: JSON.stringify({ type: "agent.message", idempotency_key: "test-contact", project: "talkai", message: "Inspect only", authority: ["inspect"] }),
    }),
    runtime,
    context,
  );
  assert.equal(response.status, 401);
  delete globalThis.__CLOUDFLARE_TEST_ENV__.AGENT_WEBHOOK_SECRET;
});
