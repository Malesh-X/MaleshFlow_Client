/// <reference types="vite/client" />
// OAuth for MCP agents (convex/oauth.ts) and what agent tokens may do
// (convex/lib/agentAuth.ts, agentVisibility.ts, agentRegistry.ts).
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { base64Url } from "../lib/domain/agentOAuth";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";
const redirectUri = "https://claude.ai/api/mcp/auth_callback";
const resource = "https://flow.example.com/api/mcp";
const verifier = "v".repeat(20) + "-verifier-0123456789abcdefghij";

async function challengeFor(value: string) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
});
afterEach(() => {
  vi.useRealTimers();
});

type T = ReturnType<typeof convexTest>;

async function register(t: T, uris = [redirectUri]) {
  const client = await t.mutation(api.oauth.registerClient, { clientName: "Claude", redirectUris: uris });
  if (!client.ok) throw new Error(client.description);
  return client.clientId;
}

async function approve(t: T, clientId: string, key = ownerKey) {
  return await t.mutation(api.oauth.approve, {
    ownerKey: key,
    clientId,
    redirectUri,
    codeChallenge: await challengeFor(verifier),
    codeChallengeMethod: "S256",
    resource,
  });
}

async function connect(t: T) {
  const clientId = await register(t);
  const approved = await approve(t, clientId);
  if (!approved.ok) throw new Error(approved.description);
  const tokens = await t.mutation(api.oauth.exchangeCode, { clientId, code: approved.code, codeVerifier: verifier, redirectUri, resource });
  if (!tokens.ok) throw new Error(tokens.description);
  return { clientId, ...tokens };
}

test("a disallowed redirect is refused at registration and at approval", async () => {
  const t = convexTest(schema, modules);
  for (const uri of ["https://evil.example.com/cb", "http://claude.ai/api/mcp/auth_callback", "https://claude.ai/other", "http://192.168.1.2:3000/cb"]) {
    const result = await t.mutation(api.oauth.registerClient, { clientName: "x", redirectUris: [uri] });
    expect(result.ok, uri).toBe(false);
  }
  const ok = await t.mutation(api.oauth.registerClient, {
    clientName: "Claude Code",
    redirectUris: ["http://localhost:53712/callback", "http://127.0.0.1:9000/cb", "https://chatgpt.com/connector_platform_oauth_redirect"],
  });
  expect(ok.ok).toBe(true);

  const clientId = await register(t);
  const wrongRedirect = await t.mutation(api.oauth.approve, {
    ownerKey,
    clientId,
    redirectUri: "https://claude.com/api/mcp/auth_callback",
    codeChallenge: await challengeFor(verifier),
    codeChallengeMethod: "S256",
  });
  expect(wrongRedirect).toMatchObject({ ok: false, error: "invalid_request" });
  const plain = await t.mutation(api.oauth.approve, { ownerKey, clientId, redirectUri, codeChallenge: verifier.slice(0, 43), codeChallengeMethod: "plain" });
  expect(plain).toMatchObject({ ok: false, error: "invalid_request" });
});

test("PKCE: the token endpoint needs the verifier that matches the S256 challenge", async () => {
  const t = convexTest(schema, modules);
  const clientId = await register(t);
  const approved = await approve(t, clientId);
  if (!approved.ok) throw new Error("not approved");
  const wrong = await t.mutation(api.oauth.exchangeCode, { clientId, code: approved.code, codeVerifier: "w".repeat(43), redirectUri, resource });
  expect(wrong).toMatchObject({ ok: false, error: "invalid_grant" });
  // The failed try used the code up.
  const retry = await t.mutation(api.oauth.exchangeCode, { clientId, code: approved.code, codeVerifier: verifier, redirectUri, resource });
  expect(retry).toMatchObject({ ok: false, error: "invalid_grant" });
});

test("codes are single use: a second exchange is refused and revokes the first one's tokens", async () => {
  const t = convexTest(schema, modules);
  const clientId = await register(t);
  const approved = await approve(t, clientId);
  if (!approved.ok) throw new Error("not approved");
  const args = { clientId, code: approved.code, codeVerifier: verifier, redirectUri, resource };
  const first = await t.mutation(api.oauth.exchangeCode, args);
  expect(first.ok).toBe(true);
  if (!first.ok) return;
  await t.query(api.workspace.listPages, { ownerKey: first.accessToken });
  expect(await t.mutation(api.oauth.exchangeCode, args)).toMatchObject({ ok: false, error: "invalid_grant" });
  await expect(t.query(api.workspace.listPages, { ownerKey: first.accessToken })).rejects.toThrow(/agent token/);
});

test("codes expire after 10 minutes, and access tokens after an hour", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-01T12:00:00Z"));
  const t = convexTest(schema, modules);
  const clientId = await register(t);
  const approved = await approve(t, clientId);
  if (!approved.ok) throw new Error("not approved");
  vi.setSystemTime(new Date("2026-11-01T12:10:01Z"));
  const late = await t.mutation(api.oauth.exchangeCode, { clientId, code: approved.code, codeVerifier: verifier, redirectUri, resource });
  expect(late).toMatchObject({ ok: false, error: "invalid_grant", description: expect.stringMatching(/expired/) });

  const tokens = await connect(t);
  expect((await t.mutation(api.oauth.authenticate, { accessToken: tokens.accessToken, resource })).ok).toBe(true);
  vi.setSystemTime(new Date("2026-11-01T13:10:02Z"));
  expect((await t.mutation(api.oauth.authenticate, { accessToken: tokens.accessToken, resource })).ok).toBe(false);
  await expect(t.query(api.workspace.listPages, { ownerKey: tokens.accessToken })).rejects.toThrow();
});

test("refresh tokens rotate; the old one is refused and its replay revokes the connection", async () => {
  const t = convexTest(schema, modules);
  const first = await connect(t);
  const second = await t.mutation(api.oauth.refresh, { clientId: first.clientId, refreshToken: first.refreshToken, resource });
  expect(second.ok).toBe(true);
  if (!second.ok) return;
  expect(second.refreshToken).not.toBe(first.refreshToken);
  await t.query(api.workspace.listPages, { ownerKey: second.accessToken });

  const replay = await t.mutation(api.oauth.refresh, { clientId: first.clientId, refreshToken: first.refreshToken, resource });
  expect(replay).toMatchObject({ ok: false, error: "invalid_grant" });
  // Replaying a used refresh token revokes everything under the grant.
  await expect(t.query(api.workspace.listPages, { ownerKey: second.accessToken })).rejects.toThrow(/agent token/);
  expect(await t.mutation(api.oauth.refresh, { clientId: first.clientId, refreshToken: second.refreshToken, resource })).toMatchObject({ ok: false });
  // Refresh tokens and codes are never access tokens.
  await expect(t.query(api.workspace.listPages, { ownerKey: second.refreshToken })).rejects.toThrow();
});

test("a token for another resource is refused", async () => {
  const t = convexTest(schema, modules);
  const tokens = await connect(t);
  expect((await t.mutation(api.oauth.authenticate, { accessToken: tokens.accessToken, resource: "https://other.example.com/mcp" })).ok).toBe(false);
});

test("revoking a connected agent refuses its token on the next request", async () => {
  const t = convexTest(schema, modules);
  const tokens = await connect(t);
  const agents = await t.query(api.oauth.listConnectedAgents, { ownerKey });
  expect(agents).toMatchObject([{ clientName: "Claude", redirectHost: "claude.ai" }]);
  expect(agents[0].lastUsedAt).not.toBeNull();
  await expect(t.query(api.oauth.listConnectedAgents, { ownerKey: tokens.accessToken })).rejects.toThrow(/Agent tokens can't/);

  await t.mutation(api.oauth.revokeConnectedAgent, { ownerKey, grantId: agents[0].grantId });
  expect(await t.query(api.oauth.listConnectedAgents, { ownerKey })).toEqual([]);
  expect((await t.mutation(api.oauth.authenticate, { accessToken: tokens.accessToken, resource })).ok).toBe(false);
  await expect(t.query(api.workspace.listPages, { ownerKey: tokens.accessToken })).rejects.toThrow(/revoked/);
  expect(await t.mutation(api.oauth.refresh, { clientId: tokens.clientId, refreshToken: tokens.refreshToken, resource })).toMatchObject({ ok: false });
});

test("a wrong owner key is refused and counts toward the lockout", async () => {
  const t = convexTest(schema, modules);
  const clientId = await register(t);
  for (let i = 0; i < 9; i += 1) {
    expect(await approve(t, clientId, "wrong")).toMatchObject({ ok: false, error: "access_denied", lockedUntil: null });
  }
  const locking = await approve(t, clientId, "wrong");
  expect(locking).toMatchObject({ ok: false, error: "access_denied" });
  expect((locking as { lockedUntil: number | null }).lockedUntil).toBeGreaterThan(Date.now());
  // Locked: wrong keys get the lockout message, but the right key still works.
  expect(await approve(t, clientId, "wrong")).toMatchObject({ ok: false, error: "access_denied", description: expect.stringMatching(/Too many/) });
  await expect(t.query(api.workspace.listPages, { ownerKey: "wrong" })).rejects.toThrow(/Too many/);
  await t.query(api.workspace.listPages, { ownerKey });
  expect(await approve(t, clientId)).toMatchObject({ ok: true });
});

test("a valid agent token keeps working while the owner key is locked out", async () => {
  const t = convexTest(schema, modules);
  const tokens = await connect(t);
  for (let i = 0; i < 12; i += 1) await t.mutation(api.workspace.checkOwnerKey, { ownerKey: "wrong" });
  await t.query(api.workspace.listPages, { ownerKey: tokens.accessToken });
  await expect(t.query(api.workspace.listPages, { ownerKey: "mfa_at_bogus" })).rejects.toThrow();
});

async function seedWorkspace(t: T) {
  const open = await t.mutation(api.workspace.createPage, { ownerKey, title: "Open", sidebarSection: "Tasks", pageType: "task" });
  const hiddenPage = await t.mutation(api.workspace.createPage, { ownerKey, title: "Hidden page", sidebarSection: "Tasks", pageType: "task" });
  const add = (pageId: Id<"pages">, text: string, parentNodeId: Id<"nodes"> | null) =>
    t.mutation(api.workspace.createNode, { ownerKey, pageId, text, parentNodeId });
  const secret = await add(open, "Secret plan", null);
  const nested = await add(open, "Nested secret", secret);
  const visible = await add(open, `Public note links [[node:${nested}]]`, null);
  const task = await add(open, "[ ] Public task", null);
  const onHidden = await add(hiddenPage, "On hidden page", null);
  await t.mutation(api.workspace.setPageDataDumpExcluded, { ownerKey, pageId: hiddenPage, excluded: true });
  await t.mutation(api.workspace.setNodeDataDumpExcluded, { ownerKey, nodeIds: [secret], excluded: true });
  return { open, hiddenPage, secret, nested, visible, task, onHidden };
}

test("agent reads leave out excluded pages and items with their subtrees", async () => {
  const t = convexTest(schema, modules);
  const ids = await seedWorkspace(t);
  const { accessToken: agent } = await connect(t);

  const pages = await t.query(api.workspace.listPages, { ownerKey: agent });
  expect(pages.map((page) => page.title)).toEqual(["Open"]);
  expect((await t.query(api.workspace.listPages, { ownerKey })).map((page) => page.title)).toContain("Hidden page");

  const tree = await t.query(api.workspace.getPageTree, { ownerKey: agent, pageId: ids.open });
  const texts = tree!.nodes.map((node) => node.text);
  expect(texts).not.toContain("Secret plan");
  expect(texts).not.toContain("Nested secret");
  expect(texts.some((text) => text.includes("Public task"))).toBe(true);
  expect(await t.query(api.workspace.getPageTree, { ownerKey: agent, pageId: ids.hiddenPage })).toBeNull();
  const ownerTree = await t.query(api.workspace.getPageTree, { ownerKey, pageId: ids.open });
  expect(ownerTree!.nodes.map((node) => node.text)).toContain("Nested secret");

  expect(await t.query(api.workspace.getNodeDetail, { ownerKey: agent, nodeId: ids.nested })).toBeNull();
  expect(await t.query(api.workspace.getNodeDetail, { ownerKey: agent, nodeId: ids.onHidden })).toBeNull();
  expect((await t.query(api.workspace.getNodeDetail, { ownerKey: agent, nodeId: ids.task }))?.node.text).toContain("Public task");
  expect((await t.query(api.workspace.getNodeDetail, { ownerKey, nodeId: ids.nested }))?.node.text).toBe("Nested secret");

  const search = await t.query(api.workspace.searchLinkTargets, { ownerKey: agent, query: "secret" });
  expect(search.nodes).toEqual([]);
  expect((await t.query(api.workspace.searchLinkTargets, { ownerKey: agent, query: "hidden" })).pages).toEqual([]);
  expect((await t.query(api.workspace.searchLinkTargets, { ownerKey, query: "secret" })).nodes.length).toBeGreaterThan(0);

  const targets = await t.query(api.workspace.resolveLinkTargets, { ownerKey: agent, nodeIds: [ids.nested], pageIds: [ids.hiddenPage] });
  expect(targets.nodes[0]).toMatchObject({ hidden: true, text: null });
  expect(targets.pages[0]).toMatchObject({ hidden: true, title: null });
});

test("agent writes that touch excluded pages or items are refused", async () => {
  const t = convexTest(schema, modules);
  const ids = await seedWorkspace(t);
  const { accessToken: agent } = await connect(t);
  const excluded = /excluded from data dumps/;

  await expect(t.mutation(api.workspace.updateNode, { ownerKey: agent, nodeId: ids.nested, text: "changed" })).rejects.toThrow(excluded);
  await expect(t.mutation(api.workspace.createNodesBatch, { ownerKey: agent, pageId: ids.hiddenPage, nodes: [{ text: "x" }] })).rejects.toThrow(excluded);
  await expect(
    t.mutation(api.workspace.createNodesBatch, { ownerKey: agent, pageId: ids.open, nodes: [{ text: "x", parentNodeId: ids.secret }] }),
  ).rejects.toThrow(excluded);
  await expect(t.mutation(api.workspace.moveNodeTree, { ownerKey: agent, nodeIds: [ids.task], parentNodeId: ids.secret })).rejects.toThrow(excluded);
  await expect(t.mutation(api.workspace.moveNodeTree, { ownerKey: agent, nodeIds: [ids.nested], parentNodeId: null })).rejects.toThrow(excluded);
  await expect(t.mutation(api.workspace.moveNodeTree, { ownerKey: agent, nodeIds: [ids.task], pageId: ids.hiddenPage })).rejects.toThrow(excluded);
  await expect(
    t.mutation(api.workspace.setNodeCompletion, { ownerKey: agent, nodeId: ids.nested, intent: "complete", completionMode: "dueDate", expectedRevision: 0 }),
  ).rejects.toThrow(excluded);
  await expect(t.mutation(api.workspace.setRecurrenceBasis, { ownerKey: agent, nodeId: ids.onHidden, basis: "today" })).rejects.toThrow(excluded);
  const ownerTree = await t.query(api.workspace.getPageTree, { ownerKey, pageId: ids.open });
  expect(ownerTree!.nodes.find((node) => node._id === ids.nested)?.text).toBe("Nested secret");

  // Visible items still work, and a completion's undo receipt works too.
  await t.mutation(api.workspace.updateNode, { ownerKey: agent, nodeId: ids.task, text: "Public task, edited" });
  const created = await t.mutation(api.workspace.createNodesBatch, { ownerKey: agent, pageId: ids.open, nodes: [{ text: "Agent note" }] });
  expect(created).toHaveLength(1);
  const detail = await t.query(api.workspace.getNodeDetail, { ownerKey: agent, nodeId: ids.task });
  const done = await t.mutation(api.workspace.setNodeCompletion, {
    ownerKey: agent,
    nodeId: ids.task,
    intent: "complete",
    completionMode: "dueDate",
    expectedRevision: detail!.node.revision ?? 0,
  });
  expect(done.status).toBe("applied");
  expect(done.receiptId).toBeTruthy();
  await t.mutation(api.workspace.undoCompletion, { ownerKey: agent, receiptIds: [done.receiptId as string] });

  // A receipt for a hidden item (made by the owner) is refused.
  const hiddenTask = await t.mutation(api.workspace.createNode, { ownerKey, pageId: ids.open, text: "[ ] Hidden task", parentNodeId: ids.secret });
  const hiddenDetail = await t.query(api.workspace.getNodeDetail, { ownerKey, nodeId: hiddenTask });
  const ownerDone = await t.mutation(api.workspace.setNodeCompletion, {
    ownerKey,
    nodeId: hiddenTask,
    intent: "complete",
    completionMode: "dueDate",
    expectedRevision: hiddenDetail!.node.revision ?? 0,
  });
  await expect(t.mutation(api.workspace.undoCompletion, { ownerKey: agent, receiptIds: [ownerDone.receiptId as string] })).rejects.toThrow(excluded);
});

test("functions outside the allowlist refuse agent tokens", async () => {
  const t = convexTest(schema, modules);
  const ids = await seedWorkspace(t);
  const { accessToken: agent } = await connect(t);
  const refused = /Agent tokens can't call this function/;
  await expect(t.query(api.workspace.listDataDumpExclusions, { ownerKey: agent })).rejects.toThrow(refused);
  await expect(t.mutation(api.workspace.setPageDataDumpExcluded, { ownerKey: agent, pageId: ids.hiddenPage, excluded: false })).rejects.toThrow(refused);
  await expect(t.mutation(api.workspace.setNodeDataDumpExcluded, { ownerKey: agent, nodeIds: [ids.secret], excluded: false })).rejects.toThrow(refused);
  await expect(t.mutation(api.workspace.setWorkspaceSettings, { ownerKey: agent, timeZone: "UTC" })).rejects.toThrow(refused);
  await expect(t.mutation(api.workspace.archivePage, { ownerKey: agent, pageId: ids.open, archived: true })).rejects.toThrow(refused);
  await expect(t.mutation(api.workspace.deletePageForever, { ownerKey: agent, pageId: ids.open } as never)).rejects.toThrow(refused);
  await expect(t.query(api.workspace.resolveNodeLinks, { ownerKey: agent, nodeIds: [ids.nested] })).rejects.toThrow(refused);
  await expect(t.mutation(api.oauth.revokeConnectedAgent, { ownerKey: agent, grantId: (await t.query(api.oauth.listConnectedAgents, { ownerKey }))[0].grantId })).rejects.toThrow(refused);
  // Agent tokens never pass as the owner key.
  expect((await t.mutation(api.workspace.checkOwnerKey, { ownerKey: agent })).valid).toBe(false);
});
