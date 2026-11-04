/// <reference types="vite/client" />
// The /api/mcp handler and the OAuth routes (lib/mcp), end to end over HTTP
// against a convex-test backend: discovery, register, authorize, token,
// tools/list and tool calls.
import { convexTest } from "convex-test";
import { anyApi } from "convex/server";
import { beforeEach, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { base64Url } from "../lib/domain/agentOAuth";
import { authorizationServerMetadata, handleMcpRequest, protectedResourceMetadata, type McpDeps } from "../lib/mcp/http";
import { handleAuthorizeGet, handleAuthorizePost, handleRegister, handleToken, type OAuthBackend } from "../lib/mcp/oauthRoutes";
import { FLOW_TOOL_NAMES } from "../lib/mcp/tools";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";
const origin = "https://flow.example.com";
const redirectUri = "http://localhost:53712/callback";
const verifier = "a-long-random-verifier-string-0123456789-abcdefghijklmnop";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
});

type T = ReturnType<typeof convexTest>;
const ref = (path: string) => {
  const [mod, name] = path.split(":");
  return anyApi[mod][name];
};

function backend(t: T): OAuthBackend {
  return {
    registerClient: (args) => t.mutation(api.oauth.registerClient, args),
    getClient: (args) => t.query(api.oauth.getClient, args),
    approve: (args) => t.mutation(api.oauth.approve, args),
    exchangeCode: (args) => t.mutation(api.oauth.exchangeCode, args),
    refresh: (args) => t.mutation(api.oauth.refresh, args),
  };
}

function deps(t: T): McpDeps {
  return {
    authenticate: async (token, resource) => (await t.mutation(api.oauth.authenticate, { accessToken: token, resource })).ok,
    calls: (token) => ({
      query: (path, args = {}) => t.query(ref(path), { ...args, ownerKey: token }),
      mutation: (path, args = {}) => t.mutation(ref(path), { ...args, ownerKey: token }),
    }),
  };
}

async function signIn(t: T) {
  const registered = await handleRegister(
    new Request(`${origin}/oauth/register`, { method: "POST", body: JSON.stringify({ client_name: "Claude Code", redirect_uris: [redirectUri] }) }),
    backend(t),
  );
  expect(registered.status).toBe(201);
  const { client_id: clientId } = (await registered.json()) as { client_id: string };
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${origin}/api/mcp`,
  });
  const page = await handleAuthorizeGet(new Request(`${origin}/oauth/authorize?${params}`), backend(t));
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("Claude Code");
  expect(html).toContain("localhost:53712");
  expect(page.headers.get("x-frame-options")).toBe("DENY");

  const post = (key: string) =>
    handleAuthorizePost(
      new Request(`${origin}/oauth/authorize`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ ...Object.fromEntries(params), owner_key: key, decision: "allow" }).toString(),
      }),
      backend(t),
    );
  const wrong = await post("wrong");
  expect(wrong.status).toBe(401);
  expect(await wrong.text()).toContain("That owner key isn&#39;t right.");

  const allowed = await post(ownerKey);
  expect(allowed.status).toBe(303);
  const location = new URL(allowed.headers.get("location")!);
  expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
  expect(location.searchParams.get("state")).toBe("xyz");
  expect(location.searchParams.get("iss")).toBe(origin);
  expect(location.toString()).not.toContain(ownerKey);

  const token = await handleToken(
    new Request(`${origin}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: location.searchParams.get("code")!,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        client_id: clientId,
        resource: `${origin}/api/mcp`,
      }).toString(),
    }),
    backend(t),
  );
  expect(token.status).toBe(200);
  return (await token.json()) as { access_token: string; refresh_token: string; token_type: string };
}

const rpc = (body: unknown, token?: string) =>
  new Request(`${origin}/api/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

test("discovery metadata points agents at Flow's OAuth server", () => {
  expect(protectedResourceMetadata(origin)).toMatchObject({ resource: `${origin}/api/mcp`, authorization_servers: [origin] });
  expect(authorizationServerMetadata(origin)).toMatchObject({
    issuer: origin,
    code_challenge_methods_supported: ["S256"],
    registration_endpoint: `${origin}/oauth/register`,
    grant_types_supported: ["authorization_code", "refresh_token"],
  });
});

test("the sign-in page refuses a redirect the client didn't register, without redirecting", async () => {
  const t = convexTest(schema, modules);
  const client = await t.mutation(api.oauth.registerClient, { clientName: "Claude", redirectUris: [redirectUri] });
  if (!client.ok) throw new Error("not registered");
  const page = await handleAuthorizeGet(
    new Request(`${origin}/oauth/authorize?client_id=${client.clientId}&redirect_uri=${encodeURIComponent("https://evil.example.com/cb")}&response_type=code`),
    backend(t),
  );
  expect(page.status).toBe(400);
  expect(page.headers.get("location")).toBeNull();
  const register = await handleRegister(
    new Request(`${origin}/oauth/register`, { method: "POST", body: JSON.stringify({ redirect_uris: ["https://evil.example.com/cb"] }) }),
    backend(t),
  );
  expect(register.status).toBe(400);
});

test("/api/mcp: 401 with WWW-Authenticate without a token; tools work with one", async () => {
  const t = convexTest(schema, modules);
  const missing = await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }), deps(t));
  expect(missing.status).toBe(401);
  expect(missing.headers.get("www-authenticate")).toContain(`resource_metadata="${origin}/.well-known/oauth-protected-resource/api/mcp"`);
  const bogus = await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, "mfa_nope"), deps(t));
  expect(bogus.status).toBe(401);
  expect(bogus.headers.get("www-authenticate")).toContain('error="invalid_token"');

  const pageId = await t.mutation(api.workspace.createPage, { ownerKey, title: "Errands", sidebarSection: "Tasks", pageType: "task" });
  const hidden = await t.mutation(api.workspace.createPage, { ownerKey, title: "Diary", sidebarSection: "Tasks", pageType: "task" });
  await t.mutation(api.workspace.setPageDataDumpExcluded, { ownerKey, pageId: hidden, excluded: true });
  const { access_token: token } = await signIn(t);

  const init = await handleMcpRequest(
    rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }, token),
    deps(t),
  );
  expect(init.status).toBe(200);
  expect(((await init.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("maleshflow");

  const list = await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }, token), deps(t));
  const tools = ((await list.json()) as { result: { tools: { name: string; annotations: { readOnlyHint: boolean } }[] } }).result.tools;
  expect(tools.map((tool) => tool.name).sort()).toEqual([...FLOW_TOOL_NAMES].sort());
  expect(tools.find((tool) => tool.name === "read_page")!.annotations.readOnlyHint).toBe(true);
  expect(tools.find((tool) => tool.name === "add_item")!.annotations.readOnlyHint).toBe(false);

  const call = async (name: string, args: Record<string, unknown>) => {
    const response = await handleMcpRequest(rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name, arguments: args } }, token), deps(t));
    const body = (await response.json()) as { result: { content: { text: string }[]; isError?: boolean } };
    return { text: body.result.content[0].text, isError: Boolean(body.result.isError) };
  };
  const pages = await call("list_pages", {});
  expect(pages.text).toContain("Errands");
  expect(pages.text).not.toContain("Diary");

  const added = await call("add_item", { pageId, text: "Buy milk", due: "2026-12-01" });
  expect(added.isError).toBe(false);
  const nodeId = added.text.match(/Added (\S+)\./)![1];
  await call("add_item", { pageId, text: `See [[node:${nodeId}]]` });
  const page = await call("read_page", { pageId });
  expect(page.text).toContain(`- [ ] Buy milk  (${nodeId})`);
  expect(page.text).toContain(`See [Buy milk](node:${nodeId})`);

  const shown = await call("show_item", { nodeId });
  expect(shown.text).toContain("due: 2026-12-01");
  const done = await call("complete_item", { nodeId });
  expect(done.text).toMatch(/Undo receipt: \S+/);
  // No workspace setting and no per-task basis: repeat from today.
  expect(done.text).toContain("(mode today)");
  const undone = await call("undo_complete", { receiptId: done.text.match(/Undo receipt: (\S+)/)![1] });
  expect(undone.text).toBe("Undone.");

  const refused = await call("read_page", { pageId: hidden });
  expect(refused.isError).toBe(true);
  expect(refused.text).toMatch(/not found/i);
});
