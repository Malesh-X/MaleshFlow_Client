/// <reference types="vite/client" />
// workspace:listDataDumpExclusions, behind the "Show Data Dump Exclusions" action.
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
});

test("lists excluded pages and items with their page, and needs the owner key", async () => {
  const t = convexTest(schema, modules);
  const open = await t.mutation(api.workspace.createPage, { ownerKey, title: "Open", sidebarSection: "Tasks", pageType: "task" });
  const hidden = await t.mutation(api.workspace.createPage, { ownerKey, title: "Hidden", sidebarSection: "Tasks", pageType: "task" });
  const add = (pageId: Id<"pages">, text: string, parentNodeId: Id<"nodes"> | null) =>
    t.mutation(api.workspace.createNode, { ownerKey, pageId, text, parentNodeId });
  const secret = await add(open, "Secret", null);
  const nested = await add(open, "Nested", secret);
  await add(open, "Public", null);
  const onHidden = await add(hidden, "On hidden page", null);

  await t.mutation(api.workspace.setPageDataDumpExcluded, { ownerKey, pageId: hidden, excluded: true });
  await t.mutation(api.workspace.setNodeDataDumpExcluded, { ownerKey, nodeIds: [secret, nested, onHidden], excluded: true });

  const result = await t.query(api.workspace.listDataDumpExclusions, { ownerKey });
  expect(result.pages.map((page) => page.title)).toEqual(["Hidden"]);
  expect(result.items.map((item) => [item.node.text, item.page.title, item.alsoCoveredBy, item.parentNode?.text ?? null])).toEqual([
    ["On hidden page", "Hidden", "page", null],
    ["Secret", "Open", null, null],
    ["Nested", "Open", "ancestor", "Secret"],
  ]);

  // Including an item takes it off the list.
  await t.mutation(api.workspace.setNodeDataDumpExcluded, { ownerKey, nodeIds: [nested], excluded: false });
  const after = await t.query(api.workspace.listDataDumpExclusions, { ownerKey });
  expect(after.items.map((item) => item.node.text)).toEqual(["On hidden page", "Secret"]);

  await expect(t.query(api.workspace.listDataDumpExclusions, { ownerKey: "wrong" })).rejects.toThrow();
});
