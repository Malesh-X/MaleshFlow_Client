/// <reference types="vite/client" />
// Legacy files download only through the authenticated route in convex/http.ts.
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
  process.env.CONVEX_SITE_URL = "https://example.convex.site";
});

test("legacy files need the owner key to download", async () => {
  const t = convexTest(schema, modules);
  const storageId = await t.run(async (ctx) => await ctx.storage.store(new Blob(["hello legacy"], { type: "text/plain" })));
  const fileId = await t.mutation(api.legacy.registerLegacyFile, { ownerKey, storageId, fileName: "notes.txt", size: 12 });

  const viewer = await t.query(api.legacy.getLegacyFileViewer, { ownerKey, fileId });
  expect(viewer?.downloadUrl).toBe(`https://example.convex.site/legacy-file?id=${fileId}`);
  const path = `/legacy-file?id=${fileId}`;

  expect((await t.fetch(path)).status).toBe(401);
  expect((await t.fetch(path, { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
  const ok = await t.fetch(path, { headers: { Authorization: `Bearer ${ownerKey}` } });
  expect(ok.status).toBe(200);
  expect(await ok.text()).toBe("hello legacy");
  expect(ok.headers.get("Content-Disposition")).toContain("attachment");

  expect((await t.fetch("/legacy-file?id=nope", { headers: { Authorization: `Bearer ${ownerKey}` } })).status).toBe(404);
  // Two wrong keys were counted.
  expect(await t.run(async (ctx) => (await ctx.db.query("authThrottle").first())?.failedCount)).toBe(2);
});
