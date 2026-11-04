/// <reference types="vite/client" />
// Retired stubs (convex/lib/retiredStubs.ts) keep tabs on older bundles from
// breaking, without revealing anything about the owner key.
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
});

const failedCount = async (t: ReturnType<typeof convexTest>) =>
  await t.run(async (ctx) => (await ctx.db.query("authThrottle").first())?.failedCount ?? 0);

test("validateOwnerKey answers null for the right key and a wrong one alike, and counts nothing", async () => {
  const t = convexTest(schema, modules);
  expect(await t.query(api.workspace.validateOwnerKey, { ownerKey })).toBeNull();
  expect(await t.query(api.workspace.validateOwnerKey, { ownerKey: "wrong" })).toBeNull();
  expect(await failedCount(t)).toBe(0);
});

test("validateOwnerKey still answers null while wrong keys are locked out", async () => {
  const t = convexTest(schema, modules);
  for (let i = 0; i < 12; i += 1) {
    await t.mutation(api.workspace.checkOwnerKey, { ownerKey: `wrong-${i}` });
  }
  await expect(t.query(api.workspace.listPages, { ownerKey: "wrong" })).rejects.toThrow(/Too many/);
  expect(await t.query(api.workspace.validateOwnerKey, { ownerKey: "wrong" })).toBeNull();
  expect(await t.query(api.workspace.validateOwnerKey, { ownerKey })).toBeNull();
});

test("queries old tabs subscribe to on load answer null", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.workspace.createPage, { ownerKey, title: "Somewhere" });
  for (const key of [ownerKey, "wrong"]) {
    expect(await t.query(api.chatData.getWorkspaceKnowledgeThread, { ownerKey: key })).toBeNull();
    expect(await t.query(api.workspace.getWorkspaceAiMemory, { ownerKey: key })).toBeNull();
    expect(await t.query(api.workspace.getWorkspaceInbox, { ownerKey: key })).toBeNull();
    expect(await t.query(api.workspace.getWorkspaceRandomBox, { ownerKey: key })).toBeNull();
  }
});
