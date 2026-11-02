/// <reference types="vite/client" />
// createNode / createNodesBatch without a parent (Phase 3, change 4): the
// page's primary section, at the end; planner pages need a parent; an
// explicit null still means the top level (what the app sends).
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { appendPlannerDayCore } from "../convex/lib/planner";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
});

async function setup() {
  const t = convexTest(schema, modules);
  const get = (id: Id<"nodes">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"nodes">>;
  const nodesOf = (pageId: Id<"pages">) =>
    t.run((ctx) => ctx.db.query("nodes").withIndex("by_page_parent_position", (q) => q.eq("pageId", pageId)).collect());
  const section = async (pageId: Id<"pages">, slot: string) =>
    (await nodesOf(pageId)).find((n) => n.parentNodeId === null && (n.sourceMeta as { sectionSlot?: string })?.sectionSlot === slot);
  const page = (title: string, sidebarSection: "Notes" | "Tasks" | "Journal", pageType: "note" | "task" | "planner" | "journal") =>
    t.mutation(api.workspace.createPage, { ownerKey, title, sidebarSection, pageType });
  // Sections are created the way the app does on first open.
  const ensureNoteSection = async (pageId: Id<"pages">) => {
    const existing = await section(pageId, "noteMain");
    if (existing) return existing._id;
    return t.run((ctx) =>
      ctx.db.insert("nodes", {
        pageId,
        parentNodeId: null,
        position: 1,
        text: "Note",
        kind: "note",
        taskStatus: null,
        priority: null,
        dueAt: null,
        archived: false,
        sourceMeta: { sectionSlot: "noteMain", locked: true },
        createdAt: 0,
        updatedAt: 0,
      }),
    );
  };
  return { t, get, nodesOf, section, page, ensureNoteSection };
}

describe("default parent", () => {
  test("createNode without a parent lands at the end of the primary section", async () => {
    const { t, get, page, ensureNoteSection } = await setup();
    const pageId = await page("Notes page", "Notes", "note");
    const sectionId = await ensureNoteSection(pageId);
    const first = await t.mutation(api.workspace.createNode, { ownerKey, pageId, text: "First" });
    const second = await t.mutation(api.workspace.createNode, { ownerKey, pageId, text: "Second" });
    expect((await get(first)).parentNodeId).toBe(sectionId);
    expect((await get(second)).parentNodeId).toBe(sectionId);
    expect((await get(second)).position).toBeGreaterThan((await get(first)).position);
  });

  test("an explicit null parent still means the top level", async () => {
    const { t, get, page, ensureNoteSection } = await setup();
    const pageId = await page("Notes page", "Notes", "note");
    await ensureNoteSection(pageId);
    const node = await t.mutation(api.workspace.createNode, { ownerKey, pageId, text: "Top", parentNodeId: null });
    expect((await get(node)).parentNodeId).toBeNull();
  });

  test("task pages default to the top level", async () => {
    const { t, get, page } = await setup();
    const pageId = await page("Tasks page", "Tasks", "task");
    const node = await t.mutation(api.workspace.createNode, { ownerKey, pageId, text: "Task", kind: "task" });
    expect((await get(node)).parentNodeId).toBeNull();
  });

  test("planner pages need a parent", async () => {
    const { t, page } = await setup();
    const pageId = await page("Planner", "Tasks", "planner");
    await expect(t.mutation(api.workspace.createNode, { ownerKey, pageId, text: "Loose" })).rejects.toThrow(/need a parent/);
    await expect(
      t.mutation(api.workspace.createNodesBatch, { ownerKey, pageId, nodes: [{ text: "Loose" }] }),
    ).rejects.toThrow(/need a parent/);
    const dayId = await t.run(async (ctx) =>
      (await appendPlannerDayCore(ctx, { page: (await ctx.db.get(pageId))!, plannerDate: Date.UTC(2026, 10, 2, 12) })).dayNodeId,
    );
    const ok = await t.mutation(api.workspace.createNode, { ownerKey, pageId, text: "On a day", parentNodeId: dayId as Id<"nodes"> });
    expect(ok).toBeTruthy();
  });

  test("createNodesBatch: entries without a parent go to the section in order; children keep theirs", async () => {
    const { t, get, page, ensureNoteSection } = await setup();
    const pageId = await page("Notes page", "Notes", "note");
    const sectionId = await ensureNoteSection(pageId);
    const existing = await t.mutation(api.workspace.createNode, { ownerKey, pageId, text: "Existing" });
    const created = await t.mutation(api.workspace.createNodesBatch, {
      ownerKey,
      pageId,
      nodes: [
        { clientId: "a", text: "A" },
        { clientId: "a1", parentClientId: "a", text: "A child" },
        { clientId: "b", afterClientId: "a", text: "B" },
      ],
    });
    const [a, a1, b] = created.map((n) => n._id);
    expect((await get(a)).parentNodeId).toBe(sectionId);
    expect((await get(a1)).parentNodeId).toBe(a);
    expect((await get(b)).parentNodeId).toBe(sectionId);
    const order = [existing, a, b].map(async (id) => (await get(id)).position);
    const [pe, pa, pb] = await Promise.all(order);
    expect(pe).toBeLessThan(pa);
    expect(pa).toBeLessThan(pb);
  });

  test("the app's batches (explicit parent, explicit after) are unchanged", async () => {
    const { t, get, page, ensureNoteSection } = await setup();
    const pageId = await page("Notes page", "Notes", "note");
    await ensureNoteSection(pageId);
    const created = await t.mutation(api.workspace.createNodesBatch, {
      ownerKey,
      pageId,
      nodes: [{ parentNodeId: null, afterNodeId: null, text: "Composer at top" }],
    });
    expect((await get(created[0]!._id)).parentNodeId).toBeNull();
  });
});
