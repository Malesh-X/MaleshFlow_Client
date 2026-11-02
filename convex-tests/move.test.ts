/// <reference types="vite/client" />
// workspace:moveNodeTree and the older move mutations (Phase 3, change 3):
// a move always carries the whole branch, its links and its favorites.
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
});

async function setup() {
  const t = convexTest(schema, modules);
  const get = (id: Id<"nodes">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"nodes">>;
  const page = (title: string) =>
    t.mutation(api.workspace.createPage, { ownerKey, title, sidebarSection: "Notes", pageType: "note" });
  const add = (pageId: Id<"pages">, text: string, parentNodeId: Id<"nodes"> | null = null) =>
    t.mutation(api.workspace.createNode, { ownerKey, pageId, text, parentNodeId });
  // A page with a root item that has a child and a grandchild.
  const branch = async (pageId: Id<"pages">) => {
    const root = await add(pageId, "Root");
    const child = await add(pageId, "Child", root);
    const grandchild = await add(pageId, "Grandchild links [[Target page]]", child);
    return { root, child, grandchild };
  };
  const childrenOf = (pageId: Id<"pages">, parentNodeId: Id<"nodes"> | null) =>
    t.run((ctx) =>
      ctx.db
        .query("nodes")
        .withIndex("by_page_parent_position", (q) => q.eq("pageId", pageId).eq("parentNodeId", parentNodeId))
        .collect(),
    );
  const move = (args: { nodeIds: Id<"nodes">[]; pageId?: Id<"pages">; parentNodeId?: Id<"nodes"> | null; afterNodeId?: Id<"nodes"> | null }) =>
    t.mutation(api.workspace.moveNodeTree, { ownerKey, ...args });
  return { t, get, page, add, branch, childrenOf, move };
}

describe("moveNodeTree", () => {
  test("moving to another page carries the whole branch, its links and favorites", async () => {
    const { t, get, page, branch, childrenOf, move } = await setup();
    const from = await page("From");
    const to = await page("To");
    await page("Target page");
    const { root, child, grandchild } = await branch(from);
    await t.mutation(api.workspace.setSidebarFavorite, { ownerKey, targetKind: "node", pageId: from, nodeId: child, favorited: true });
    const revisionBefore = (await get(grandchild)).revision ?? 0;

    const result = await move({ nodeIds: [root], pageId: to });
    expect(result.pageId).toBe(to);

    for (const id of [root, child, grandchild]) expect((await get(id)).pageId).toBe(to);
    expect((await get(root)).parentNodeId).toBeNull();
    expect((await get(grandchild)).revision).toBeGreaterThan(revisionBefore);
    expect((await childrenOf(from, null)).some((n) => n._id === root)).toBe(false);

    const links = await t.run((ctx) => ctx.db.query("links").collect());
    const grandchildLinks = links.filter((link) => link.sourceNodeId === grandchild);
    expect(grandchildLinks.length).toBeGreaterThan(0);
    for (const link of grandchildLinks) expect(link.sourcePageId).toBe(to);

    const favorites = await t.run((ctx) => ctx.db.query("sidebarFavorites").collect());
    expect(favorites.find((f) => f.targetNodeId === child)?.targetPageId).toBe(to);
  });

  test("appends at the end by default and keeps the listed order", async () => {
    const { page, add, childrenOf, move } = await setup();
    const from = await page("From");
    const to = await page("To");
    const a = await add(from, "A");
    const b = await add(from, "B");
    const parent = await add(to, "Parent");
    const existing = await add(to, "Existing", parent);
    await move({ nodeIds: [a, b], parentNodeId: parent });
    const order = (await childrenOf(to, parent)).sort((x, y) => x.position - y.position).map((n) => n._id);
    expect(order).toEqual([existing, a, b]);
  });

  test("refuses moves that would break the tree", async () => {
    const { page, add, branch, move, t } = await setup();
    const from = await page("From");
    const other = await page("Other");
    const { root, grandchild } = await branch(from);
    const elsewhere = await add(other, "Elsewhere");
    await expect(move({ nodeIds: [root], parentNodeId: root })).rejects.toThrow(/own parent/);
    await expect(move({ nodeIds: [root], parentNodeId: grandchild })).rejects.toThrow(/loop/);
    await expect(move({ nodeIds: [root], pageId: from, parentNodeId: elsewhere })).rejects.toThrow(/different page/);
    await t.mutation(api.workspace.archivePage, { ownerKey, pageId: other, archived: true });
    await expect(move({ nodeIds: [root], pageId: other })).rejects.toThrow(/active page/);
  });

  test("an item listed with its own ancestor moves once, inside its branch", async () => {
    const { get, page, branch, move } = await setup();
    const from = await page("From");
    const to = await page("To");
    const { root, child } = await branch(from);
    const result = await move({ nodeIds: [root, child], pageId: to });
    expect(result.movedNodeIds).toEqual([root]);
    expect((await get(child)).parentNodeId).toBe(root);
    expect((await get(child)).pageId).toBe(to);
  });
});

describe("older move mutations (open tabs, drag and drop, cut and paste)", () => {
  test("moveNode to another page no longer strands the children", async () => {
    const { t, get, page, branch } = await setup();
    const from = await page("From");
    const to = await page("To");
    const anchor = await t.mutation(api.workspace.createNode, { ownerKey, pageId: to, text: "Anchor" });
    const { root, child, grandchild } = await branch(from);
    await t.mutation(api.workspace.moveNode, { ownerKey, nodeId: root, pageId: to, parentNodeId: null, afterNodeId: anchor });
    for (const id of [root, child, grandchild]) expect((await get(id)).pageId).toBe(to);
  });

  test("moveNodesBatch and moveNodeTreesToPage carry branches too", async () => {
    const { t, get, page, branch } = await setup();
    const from = await page("From");
    const to = await page("To");
    const one = await branch(from);
    const two = await branch(from);
    await t.mutation(api.workspace.moveNodesBatch, {
      ownerKey,
      moves: [{ nodeId: one.root, pageId: to, parentNodeId: null, afterNodeId: null }],
    });
    await t.mutation(api.workspace.moveNodeTreesToPage, { ownerKey, targetPageId: to, nodeIds: [two.root] });
    for (const id of [one.child, one.grandchild, two.child, two.grandchild]) expect((await get(id)).pageId).toBe(to);
  });

  test("same-page moves keep today's behavior (afterNodeId null = first)", async () => {
    const { t, page, add, childrenOf } = await setup();
    const p = await page("P");
    const a = await add(p, "A");
    const b = await add(p, "B");
    await t.mutation(api.workspace.moveNode, { ownerKey, nodeId: b, afterNodeId: null });
    const order = (await childrenOf(p, null)).sort((x, y) => x.position - y.position).map((n) => n._id);
    expect(order.indexOf(b)).toBeLessThan(order.indexOf(a));
  });
});
