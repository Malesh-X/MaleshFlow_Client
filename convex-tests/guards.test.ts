/// <reference types="vite/client" />
// Mutation tests for the Phase 2 write guards (convex/lib/guards.ts).
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { appendPlannerDayCore } from "../convex/lib/planner";
import { assertNodeEditable, assertValidParent, normalizeSchedule, withGuards } from "../convex/lib/guards";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
});

function setup() {
  const t = convexTest(schema, modules);
  const violations = () => t.run((ctx) => ctx.db.query("guardViolations").collect());
  const node = (id: Id<"nodes">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"nodes"> | null>;
  const nodesOf = (pageId: Id<"pages">) =>
    t.run((ctx) => ctx.db.query("nodes").withIndex("by_page_archived", (q) => q.eq("pageId", pageId)).collect());
  const section = async (pageId: Id<"pages">, slot: string) =>
    (await nodesOf(pageId)).find((n) => (n.sourceMeta as Record<string, unknown> | undefined)?.sectionSlot === slot)!;
  const notePage = async (title = "Notes") => {
    const pageId = await t.mutation(api.workspace.createPage, { ownerKey, title, sidebarSection: "Notes", pageType: "note" });
    return { pageId, main: (await section(pageId, "noteMain"))._id };
  };
  const add = (pageId: Id<"pages">, text: string, parentNodeId: Id<"nodes"> | null, extra: Record<string, unknown> = {}) =>
    t.mutation(api.workspace.createNode, { ownerKey, pageId, text, parentNodeId, ...extra });
  return { t, violations, node, nodesOf, section, notePage, add };
}

describe("normal app flows", () => {
  test("record no violations", async () => {
    const { t, violations, notePage, add, node } = setup();
    const { pageId, main } = await notePage();
    const other = await notePage("Other");
    const a = await add(pageId, "A", main);
    const b = await add(pageId, "B", a);
    await t.mutation(api.workspace.createNodesBatch, {
      ownerKey,
      pageId,
      nodes: [
        { clientId: "x", text: "X", parentNodeId: main, kind: "task", taskStatus: "todo", dueAt: 1000, dueEndAt: 2000 },
        { clientId: "y", text: "Y", parentClientId: "x" },
      ],
    });
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: b, text: "B2", kind: "task", lockKind: true, taskStatus: "todo" });
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: b, dueAt: 5000, recurrenceFrequency: "weekly" });
    await t.mutation(api.workspace.updateNode, {
      ownerKey, nodeId: b, dueAt: null, dueEndAt: null, dueTime: null, dueTimeZone: null, recurrenceFrequency: null,
    });
    await t.mutation(api.workspace.updateNodesBatch, { ownerKey, updates: [{ nodeId: b, taskStatus: "done" }] });
    await t.mutation(api.workspace.moveNode, { ownerKey, nodeId: b, parentNodeId: main, afterNodeId: null });
    await t.mutation(api.workspace.reorderNode, { ownerKey, nodeId: b, afterNodeId: a });
    await t.mutation(api.workspace.moveNodeTreesToPage, { ownerKey, targetPageId: other.pageId, nodeIds: [a] });
    await t.mutation(api.workspace.setNodeTreeArchived, { ownerKey, nodeId: a, archived: true });
    await t.mutation(api.workspace.setNodeTreeArchived, { ownerKey, nodeId: a, archived: false });
    await t.mutation(api.workspace.renamePage, { ownerKey, pageId, title: "Renamed" });
    expect((await node(b))?.taskStatus).toBe("done");
    expect(await violations()).toEqual([]);
  });
});

describe("planner, task page and page-type flows", () => {
  test("record no violations", async () => {
    const { t, violations, nodesOf, section, add, node } = setup();
    for (const [sidebarSection, pageType] of [
      ["Models", "model"], ["Journal", "journal"], ["Views", "multiPage"], ["Scratchpads", "scratchpad"], ["Templates", "default"], ["Notes", "note"],
    ] as const) {
      await t.mutation(api.workspace.createPage, { ownerKey, title: sidebarSection, sidebarSection, pageType });
    }

    // Planner: days, an item under a day, completing it and the day.
    const plannerId = await t.mutation(api.workspace.createPage, { ownerKey, title: "Plan", sidebarSection: "Tasks", pageType: "planner" });
    const startDate = new Date(2026, 10, 2, 12).getTime();
    await t.mutation(api.planner.setPlannerStartDate, { ownerKey, pageId: plannerId, startDate });
    // Seed the first day the way the server does, then append one through the mutation.
    await t.run(async (ctx) => {
      await appendPlannerDayCore(ctx, { page: (await ctx.db.get(plannerId))!, plannerDate: startDate });
    });
    await t.mutation(api.planner.appendPlannerDay, { ownerKey, pageId: plannerId });
    const days = (await nodesOf(plannerId)).filter((n) => (n.sourceMeta as Record<string, unknown>)?.plannerKind === "plannerDay");
    expect(days.length).toBeGreaterThan(0);
    const item = await add(plannerId, "Plan item", days[0]._id, { kind: "task", taskStatus: "todo" });
    await t.mutation(api.planner.completePlannerTask, { ownerKey, plannerNodeId: item, completionMode: "dueDate" });
    const focus = await section(plannerId, "plannerFocus");
    if (focus) {
      const focusItem = await add(plannerId, "Focus item", focus._id, { kind: "task", taskStatus: "todo" });
      await t.mutation(api.planner.completePlannerTask, { ownerKey, plannerNodeId: focusItem, completionMode: "today" });
    }
    await t.mutation(api.planner.completePlannerDay, { ownerKey, pageId: plannerId });

    // Task page with a Done archive, and a recurring task rolling forward.
    const taskPage = await t.mutation(api.workspace.createPage, { ownerKey, title: "Tasks", sidebarSection: "Tasks", pageType: "task" });
    await t.mutation(api.workspace.setTaskPageDoneArchiveEnabled, { ownerKey, pageId: taskPage, enabled: true });
    const task = await add(taskPage, "Task", null, { kind: "task", taskStatus: "todo" });
    await t.mutation(api.workspace.completeTaskPageTask, { ownerKey, nodeId: task, completionMode: "dueDate" });
    const recurring = await add(taskPage, "Recurring", null, { kind: "task", taskStatus: "todo", dueAt: 1_800_000_000_000, recurrenceFrequency: "daily" });
    await t.mutation(api.workspace.completeTaskPageTask, { ownerKey, nodeId: recurring, completionMode: "dueDate" });
    expect((await node(recurring))?.dueAt).toBeGreaterThan(1_800_000_000_000);

    expect((await violations()).map((row) => `${row.mutation} ${row.guard}: ${row.detail}`)).toEqual([]);
  });
});

describe("record mode logs violations and still writes", () => {
  test("cycles", async () => {
    const { t, violations, notePage, add, node } = setup();
    const { pageId, main } = await notePage();
    const a = await add(pageId, "A", main);
    const b = await add(pageId, "B", a);
    await t.mutation(api.workspace.moveNode, { ownerKey, nodeId: a, parentNodeId: b });
    const rows = await violations();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mutation: "workspace:moveNode", guard: "assertValidParent", mode: "record", nodeId: a });
    expect(rows[0].detail).toMatch(/loop/);
    expect((await node(a))?.parentNodeId).toBe(b);
  });

  test("self parent and cross-page parents", async () => {
    const { t, violations, notePage, add } = setup();
    const one = await notePage("One");
    const two = await notePage("Two");
    const a = await add(one.pageId, "A", one.main);
    await t.mutation(api.workspace.moveNode, { ownerKey, nodeId: a, parentNodeId: a });
    await t.mutation(api.workspace.moveNode, { ownerKey, nodeId: a, parentNodeId: two.main });
    await add(one.pageId, "C", two.main);
    await t.mutation(api.workspace.moveNodesBatch, { ownerKey, moves: [{ nodeId: a, pageId: one.pageId, parentNodeId: two.main }] });
    const details = (await violations()).map((row) => `${row.mutation} ${row.detail}`);
    expect(details).toEqual([
      expect.stringMatching(/workspace:moveNode .*own parent/),
      expect.stringMatching(/workspace:moveNode .*different page/),
      expect.stringMatching(/workspace:createNode .*different page/),
      expect.stringMatching(/workspace:moveNodesBatch .*different page/),
    ]);
  });

  test("locked items", async () => {
    const { t, violations, notePage } = setup();
    const { main } = await notePage();
    await t.mutation(api.workspace.setNodeTreeArchived, { ownerKey, nodeId: main, archived: true });
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: main, kind: "task" });
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: main, text: "Renaming a section is fine" });
    await t.mutation(api.workspace.deleteNode, { ownerKey, nodeId: main });
    const rows = await violations();
    expect(rows.map((row) => [row.mutation, row.guard])).toEqual([
      ["workspace:setNodeTreeArchived", "assertNodeEditable"],
      ["workspace:updateNode", "assertNodeEditable"],
      ["workspace:deleteNode", "assertNodeEditable"],
    ]);
    expect(rows[0].detail).toMatch(/^archive: Section headers/);
  });

  test("archived pages", async () => {
    const { t, violations, notePage, add } = setup();
    const { pageId, main } = await notePage();
    const a = await add(pageId, "A", main);
    await t.mutation(api.workspace.archivePage, { ownerKey, pageId, archived: true });
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: a, text: "edit" });
    await add(pageId, "B", main);
    const rows = await violations();
    // archivePage leaves the page's nodes active, so only the page check fires.
    expect(rows.map((row) => [row.mutation, row.guard])).toEqual([
      ["workspace:updateNode", "assertNodeEditable"],
      ["workspace:createNode", "assertPageWritable"],
    ]);
    expect(rows.every((row) => /archived/.test(row.detail))).toBe(true);
  });

  test("schedule normalization on create, batch create, update and batch update", async () => {
    const { t, violations, notePage, add, node } = setup();
    const { pageId, main } = await notePage();
    // create: recurrence with no due date
    await add(pageId, "R", main, { kind: "task", taskStatus: "todo", recurrenceFrequency: "daily" });
    // batch create: end date before the due date
    await t.mutation(api.workspace.createNodesBatch, {
      ownerKey, pageId, nodes: [{ text: "E", parentNodeId: main, kind: "task", taskStatus: "todo", dueAt: 2000, dueEndAt: 1000 }],
    });
    // update: clearing the due date leaves recurrence and end date
    const task = await add(pageId, "T", main, { kind: "task", taskStatus: "todo", dueAt: 1000, dueEndAt: 3000, recurrenceFrequency: "weekly" });
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: task, dueAt: null });
    // batch update: a note given a task status
    const note = await add(pageId, "N", main);
    await t.mutation(api.workspace.updateNodesBatch, { ownerKey, updates: [{ nodeId: note, taskStatus: "todo" }] });

    const rows = await violations();
    expect(rows.map((row) => [row.mutation, row.guard])).toEqual([
      ["workspace:createNode", "normalizeSchedule"],
      ["workspace:createNodesBatch", "normalizeSchedule"],
      ["workspace:updateNode", "normalizeSchedule"],
      ["workspace:updateNodesBatch", "normalizeSchedule"],
    ]);
    expect(rows[0].detail).toMatch(/recurrence without a due date/);
    expect(rows[1].detail).toMatch(/end date isn't after the due date/);
    expect(rows[2].detail).toMatch(/dueEndAt.*recurrenceFrequency/);
    expect(rows[3].detail).toMatch(/note can't have task status/);
    // Record mode leaves the writes as sent.
    expect((await node(task))?.dueEndAt).toBe(3000);
    expect((await node(note))?.taskStatus).toBe("todo");
  });
});

describe("revision counter", () => {
  test("bumps on every node write through a guarded mutation", async () => {
    const { t, notePage, add, node } = setup();
    const { pageId, main } = await notePage();
    const a = await add(pageId, "A", main);
    expect((await node(a))?.revision).toBe(1);
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: a, text: "A2" });
    expect((await node(a))?.revision).toBe(2);
    await t.mutation(api.workspace.reorderNode, { ownerKey, nodeId: a, afterNodeId: null });
    await t.mutation(api.workspace.setNodeTreeArchived, { ownerKey, nodeId: a, archived: true });
    expect((await node(a))?.revision).toBe(4);
  });

  test("bumps whole branches and pre-existing nodes without a revision", async () => {
    const { t, notePage, add, node } = setup();
    const { pageId, main } = await notePage();
    const a = await add(pageId, "A", main);
    const b = await add(pageId, "B", a);
    await t.run((ctx) => ctx.db.patch(b, { revision: undefined }));
    const other = await notePage("Other");
    await t.mutation(api.workspace.moveNodeTreesToPage, { ownerKey, targetPageId: other.pageId, nodeIds: [a] });
    expect((await node(a))?.revision).toBe(2);
    expect((await node(b))?.revision).toBe(1);
  });
});

describe("record vs enforce", () => {
  test("enforce throws ConvexError and records nothing; record logs and continues", async () => {
    const { t, violations, notePage } = setup();
    const { main } = await notePage();
    await expect(
      t.run(async (ctx) => {
        await assertNodeEditable(withGuards(ctx, "test:enforce", { mode: "enforce" }), main, "archive");
      }),
    ).rejects.toThrow(ConvexError);
    expect(await violations()).toEqual([]);
    await t.run(async (ctx) => {
      await assertNodeEditable(withGuards(ctx, "test:record", { mode: "record" }), main, "archive");
    });
    expect((await violations()).map((row) => row.mutation)).toEqual(["test:record"]);
  });

  test("enforce rejects bad parents", async () => {
    const { t, notePage, add } = setup();
    const { pageId, main } = await notePage();
    const a = await add(pageId, "A", main);
    const b = await add(pageId, "B", a);
    await expect(
      t.run(async (ctx) => {
        await assertValidParent(withGuards(ctx, "test", { mode: "enforce" }), { nodeId: a, parentNodeId: b, pageId });
      }),
    ).rejects.toThrow(/loop/);
  });

  test("enforce normalizes schedules and refuses recurrence without a due date", async () => {
    const { t, violations, notePage, add, node } = setup();
    const { pageId, main } = await notePage();
    const task = await add(pageId, "T", main, { kind: "task", taskStatus: "todo", dueAt: 1000, dueEndAt: 3000, recurrenceFrequency: "weekly" });
    const before = (await node(task))!;
    const fixed = await t.run((ctx) => normalizeSchedule(withGuards(ctx, "test", { mode: "enforce" }), { before, write: { dueAt: null } }));
    // Only fields that were set get cleared (this task had no time).
    expect(fixed).toMatchObject({ dueAt: null, dueEndAt: null });
    expect((fixed as { sourceMeta?: Record<string, unknown> }).sourceMeta?.recurrenceFrequency).toBeNull();
    await expect(
      t.run((ctx) =>
        normalizeSchedule(withGuards(ctx, "test", { mode: "enforce" }), {
          before: { ...before, dueAt: null },
          write: { sourceMeta: { recurrenceFrequency: "daily" } },
        }),
      ),
    ).rejects.toThrow(/needs a due date/);
    expect(await violations()).toEqual([]);
  });
});

test("guardViolations:list returns rows to the owner only", async () => {
  const { t, notePage } = setup();
  const { main } = await notePage();
  await t.mutation(api.workspace.deleteNode, { ownerKey, nodeId: main });
  const result = await t.query(api.guardViolations.list, { ownerKey });
  expect(result).toMatchObject({ mode: "record", total: 1, counts: { "workspace:deleteNode / assertNodeEditable": 1 } });
  await expect(t.query(api.guardViolations.list, { ownerKey: "wrong" })).rejects.toThrow();
});
