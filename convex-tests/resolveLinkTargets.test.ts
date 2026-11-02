/// <reference types="vite/client" />
// workspace:resolveLinkTargets, the Flow CLI's bulk link lookup, and the
// CLI's read → write-back round trip through updateNode.
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { linkLookup, renderLinks, toStoredLinkText } from "../scripts/flowLinks";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
});

async function setup() {
  const t = convexTest(schema, modules);
  const open = await t.mutation(api.workspace.createPage, { ownerKey, title: "Open", sidebarSection: "Tasks", pageType: "task" });
  const hiddenPage = await t.mutation(api.workspace.createPage, { ownerKey, title: "Hidden", sidebarSection: "Tasks", pageType: "task" });
  const add = (pageId: Id<"pages">, text: string, parentNodeId: Id<"nodes"> | null = null) =>
    t.mutation(api.workspace.createNode, { ownerKey, pageId, text, parentNodeId });
  return { t, open, hiddenPage, add };
}

test("resolves text, titles, missing and hidden targets in one call", async () => {
  const { t, open, hiddenPage, add } = await setup();
  const dentist = await add(open, "Dentist appointment");
  const secret = await add(open, "Secret");
  const nested = await add(open, "Nested under secret", secret);
  const onHidden = await add(hiddenPage, "On hidden page");
  const gone = await add(open, "Deleted soon");
  await t.mutation(api.workspace.deleteNode, { ownerKey, nodeId: gone });
  await t.mutation(api.workspace.setNodeDataDumpExcluded, { ownerKey, nodeIds: [secret], excluded: true });
  await t.mutation(api.workspace.setPageDataDumpExcluded, { ownerKey, pageId: hiddenPage, excluded: true });

  const result = await t.query(api.workspace.resolveLinkTargets, {
    ownerKey,
    nodeIds: [dentist, nested, onHidden, gone, "not-an-id"],
    pageIds: [open, hiddenPage],
  });
  expect(result.nodes.map((n) => [n.text, n.found, n.hidden])).toEqual([
    ["Dentist appointment", true, false],
    [null, true, true],
    [null, true, true],
    [null, false, false],
    [null, false, false],
  ]);
  expect(result.nodes[0].pageId).toBe(open);
  expect(result.pages.map((p) => [p.title, p.hidden])).toEqual([
    ["Open", false],
    [null, true],
  ]);
  await expect(t.query(api.workspace.resolveLinkTargets, { ownerKey: "wrong", nodeIds: [], pageIds: [] })).rejects.toThrow();
});

test("printed text written back through updateNode stores the original text", async () => {
  const { t, open, add } = await setup();
  const dentist = await add(open, "Dentist appointment");
  const original = `Call [[node:${dentist}?hidetags]] and ((${dentist})) re [[Teeth|node:${dentist}]] on [[page:${open}]]`;
  const item = await add(open, original);
  const stored = async () => (await t.run((ctx) => ctx.db.get(item)))!.text;
  expect(await stored()).toBe(original);

  const targets = await t.query(api.workspace.resolveLinkTargets, { ownerKey, nodeIds: [dentist], pageIds: [open] });
  const { displayText } = renderLinks(original, linkLookup(targets));
  expect(displayText).toBe(
    `Call [Dentist appointment](node:${dentist}?hidetags) and [Dentist appointment](node:${dentist}) re [Teeth → Dentist appointment](node:${dentist}) on [Open](page:${open})`,
  );

  await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: item, text: toStoredLinkText(displayText, original), parseDraft: true });
  expect(await stored()).toBe(original);
});
