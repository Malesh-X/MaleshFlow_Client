/// <reference types="vite/client" />
// Owner-key lockout (convex/lib/authThrottle.ts): wrong keys are counted where
// a write can commit, and the correct key always works.
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { constantTimeEqual } from "../convex/lib/auth";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
});

const failedCount = async (t: ReturnType<typeof convexTest>) =>
  await t.run(async (ctx) => (await ctx.db.query("authThrottle").first())?.failedCount ?? 0);

test("10+ wrong attempts lock out wrong keys, and the correct key still works", async () => {
  const t = convexTest(schema, modules);
  for (let i = 0; i < 12; i += 1) {
    const result = await t.mutation(api.workspace.checkOwnerKey, { ownerKey: `wrong-${i}` });
    expect(result.valid).toBe(false);
  }
  const locked = await t.mutation(api.workspace.checkOwnerKey, { ownerKey: "wrong" });
  expect(locked.lockedUntil).toBeGreaterThan(Date.now());
  await expect(t.query(api.workspace.listPages, { ownerKey: "wrong" })).rejects.toThrow(/Too many/);
  await expect(t.mutation(api.workspace.createPage, { ownerKey: "wrong", title: "x" })).rejects.toThrow(/Too many/);

  // The correct key works in every kind of function while locked.
  await t.query(api.workspace.listPages, { ownerKey });
  await t.mutation(api.workspace.createPage, { ownerKey, title: "Still works" });
  await t.action(api.importExport.exportWorkspace, { ownerKey });
  expect(await t.mutation(api.workspace.checkOwnerKey, { ownerKey })).toEqual({ valid: true, lockedUntil: null });
  // ...and clears the counter.
  expect(await failedCount(t)).toBe(0);
});

test("actions count a wrong key before refusing it", async () => {
  const t = convexTest(schema, modules);
  await expect(t.action(api.importExport.exportWorkspace, { ownerKey: "wrong" })).rejects.toThrow(/Invalid owner access token/);
  await expect(t.action(api.importExport.exportWorkspace, { ownerKey: "wrong" })).rejects.toThrow(/Invalid owner access token/);
  expect(await failedCount(t)).toBe(2);
});

test("queries and throwing mutations can't count a wrong key", async () => {
  const t = convexTest(schema, modules);
  await expect(t.query(api.workspace.listPages, { ownerKey: "wrong" })).rejects.toThrow(/Invalid/);
  await expect(t.mutation(api.workspace.createPage, { ownerKey: "wrong", title: "x" })).rejects.toThrow(/Invalid/);
  expect(await failedCount(t)).toBe(0);
});

test("constantTimeEqual", () => {
  expect(constantTimeEqual("abc", "abc")).toBe(true);
  expect(constantTimeEqual("abc", "abd")).toBe(false);
  expect(constantTimeEqual("abc", "abcd")).toBe(false);
  expect(constantTimeEqual("", "")).toBe(true);
  expect(constantTimeEqual("", "a")).toBe(false);
});
