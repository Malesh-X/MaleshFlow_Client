/// <reference types="vite/client" />
// workspace:setNodesCompletion: the app's multi-item check-off in one call,
// with the same per-item rules as setNodeCompletion and one undo step.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { appendPlannerDayCore, appendPlannerLinkedTaskCopy } from "../convex/lib/planner";
import schema from "../convex/schema";
import { zonedNoon } from "../lib/domain/timeZone";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";
const HNL = "Pacific/Honolulu";
const day = (d: number) => zonedNoon({ year: 2026, month: 11, day: d }, HNL);

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T20:00:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.workspace.setWorkspaceSettings, { ownerKey, timeZone: HNL });
  const get = (id: Id<"nodes">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"nodes">>;
  const meta = async (id: Id<"nodes">) => ((await get(id)).sourceMeta ?? {}) as Record<string, unknown>;
  const item = async (nodeId: Id<"nodes">, intent: "complete" | "reopen" = "complete") => ({
    nodeId,
    intent,
    expectedRevision: (await get(nodeId)).revision ?? 0,
  });
  const batch = async (ids: Id<"nodes">[], completionMode: "dueDate" | "today" = "dueDate") =>
    t.mutation(api.workspace.setNodesCompletion, {
      ownerKey,
      completionMode,
      items: await Promise.all(ids.map((id) => item(id))),
    });
  const single = async (id: Id<"nodes">, completionMode: "dueDate" | "today" = "dueDate") =>
    t.mutation(api.workspace.setNodeCompletion, { ownerKey, completionMode, ...(await item(id)) });
  const page = (title: string, sidebarSection: "Tasks" | "Notes", pageType: "task" | "note" | "planner") =>
    t.mutation(api.workspace.createPage, { ownerKey, title, sidebarSection, pageType });
  const add = (pageId: Id<"pages">, text: string, extra: Record<string, unknown> = {}) =>
    t.mutation(api.workspace.createNode, { ownerKey, pageId, text, ...extra });
  const planner = async (title: string, date: number) => {
    const pageId = await page(title, "Tasks", "planner");
    const dayId = (await t.run(async (ctx) => appendPlannerDayCore(ctx, { page: (await ctx.db.get(pageId))!, plannerDate: date }))).dayNodeId;
    return { pageId, dayId: dayId as Id<"nodes"> };
  };
  const linkCopy = (plannerPageId: Id<"pages">, dayId: Id<"nodes">, date: number, sourceId: Id<"nodes">) =>
    t.run(async (ctx) =>
      appendPlannerLinkedTaskCopy(ctx, {
        plannerPageId,
        parentNodeId: dayId,
        plannerDate: date,
        sourceTask: await ctx.db.get(sourceId).then((source) => ({ ...source!, dueEndAt: source!.dueEndAt ?? null })),
        afterNodeId: null,
      }),
    ) as Promise<Id<"nodes">>;
  const receiptCount = () => t.run(async (ctx) => (await ctx.db.query("undoReceipts").collect()).length);
  return { t, get, meta, item, batch, single, page, add, planner, linkCopy, receiptCount };
}

// What completion changes on an item, for comparing a batch with one-by-one.
const outcome = (node: Doc<"nodes">) => {
  const m = (node.sourceMeta ?? {}) as Record<string, unknown>;
  return {
    taskStatus: node.taskStatus ?? null,
    dueAt: node.dueAt ?? null,
    dueEndAt: node.dueEndAt ?? null,
    archived: node.archived,
    occurrenceIndex: m.occurrenceIndex ?? null,
    noteCompleted: m.noteCompleted ?? null,
  };
};

describe("setNodesCompletion", () => {
  test("ten items complete in one call with one receipt each, and one undo restores them all", async () => {
    const { t, get, batch, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const ids: Id<"nodes">[] = [];
    for (let i = 0; i < 9; i += 1) ids.push(await add(pageId, `Task ${i}`, { kind: "task", taskStatus: "todo" }));
    ids.push(await add(pageId, "A note"));
    const result = await batch(ids);
    expect(result.status).toBe("applied");
    expect(result.results).toHaveLength(10);
    expect(result.receiptIds).toHaveLength(10);
    for (const id of ids.slice(0, 9)) expect((await get(id)).taskStatus).toBe("done");
    expect(((await get(ids[9]!)).sourceMeta as Record<string, unknown>).noteCompleted).toBe(true);

    // The app's undo step sends the receipts newest first.
    await t.mutation(api.workspace.undoCompletion, { ownerKey, receiptIds: [...result.receiptIds].reverse() });
    for (const id of ids.slice(0, 9)) expect((await get(id)).taskStatus).toBe("todo");
    expect(((await get(ids[9]!)).sourceMeta as Record<string, unknown>).noteCompleted ?? false).toBe(false);
  });

  test("recurring, planner-linked and Done-archive items in one batch end up as when completed one by one", async () => {
    const { t, get, batch, single, page, add, planner, linkCopy } = await setup();
    const tasks = await page("Tasks", "Tasks", "task");
    const notes = await page("Plain", "Notes", "note");
    const donePage = await page("Done tasks", "Tasks", "task");
    await t.mutation(api.workspace.setTaskPageDoneArchiveEnabled, { ownerKey, pageId: donePage, enabled: true });
    const plan = await planner("Plan", day(2));
    const world = async (label: string) => {
      const recurring = await add(notes, `${label} weekly`, { kind: "task", taskStatus: "todo", dueAt: day(2), recurrenceFrequency: "weekly" });
      const todayBasis = await add(notes, `${label} daily`, { kind: "task", taskStatus: "todo", dueAt: day(1), recurrenceFrequency: "daily" });
      const source = await add(tasks, `${label} source`, { kind: "task", taskStatus: "todo", dueAt: day(2), recurrenceFrequency: "daily" });
      const copy = await linkCopy(plan.pageId, plan.dayId, day(2), source);
      const archived = await add(donePage, `${label} ship`, { kind: "task", taskStatus: "todo" });
      return { recurring, todayBasis, source, copy, archived };
    };
    const one = await world("batch");
    const two = await world("single");
    const order = (w: typeof one) => [w.recurring, w.todayBasis, w.copy, w.archived];

    const result = await batch(order(one), "today");
    expect(result.results.map((r) => r.route)).toEqual(["recurring", "recurring", "planner", "taskPage"]);
    for (const id of order(two)) expect((await single(id, "today")).status).toBe("applied");

    for (const key of ["recurring", "todayBasis", "source", "copy", "archived"] as const) {
      expect(outcome(await get(one[key])), key).toEqual(outcome(await get(two[key])));
    }
    // The planner copy's source rolled forward once and its occurrence token moved.
    expect((await get(one.source)).dueAt).toBe(day(3));
    expect(((await get(one.source)).sourceMeta as Record<string, unknown>).occurrenceIndex).toBe(1);
    expect(result.results.filter((r) => r.movesItem)).toHaveLength(2);
  });

  test("one stale revision refuses the whole batch and writes nothing", async () => {
    const { t, get, item, page, add, receiptCount } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const a = await add(pageId, "A", { kind: "task", taskStatus: "todo" });
    const b = await add(pageId, "B", { kind: "task", taskStatus: "todo" });
    const c = await add(pageId, "C", { kind: "task", taskStatus: "todo" });
    const items = [await item(a), await item(b), await item(c)];
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: b, text: "B, edited elsewhere" });
    const before = await Promise.all([a, b, c].map(get));
    const receipts = await receiptCount();

    const result = await t.mutation(api.workspace.setNodesCompletion, { ownerKey, completionMode: "dueDate", items });
    expect(result.status).toBe("stale");
    expect(result.message).toMatch(/Nothing was checked off/);
    expect(result.conflicts.map((conflict) => conflict.nodeId)).toEqual([b]);
    expect(result.receiptIds).toEqual([]);
    expect(await Promise.all([a, b, c].map(get))).toEqual(before);
    expect(await receiptCount()).toBe(receipts);
  });

  test("an error on any item rolls back the items before it", async () => {
    const { t, get, item, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const a = await add(pageId, "A", { kind: "task", taskStatus: "todo" });
    const locked = await add(pageId, "Locked", { kind: "task", taskStatus: "todo" });
    const items = [await item(a), await item(locked)];
    await t.mutation(api.workspace.deleteNode, { ownerKey, nodeId: locked });
    await expect(t.mutation(api.workspace.setNodesCompletion, { ownerKey, completionMode: "dueDate", items })).rejects.toThrow();
    expect((await get(a)).taskStatus).toBe("todo");
  });

  test("more than 200 items are refused", async () => {
    const { t, item, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const one = await item(await add(pageId, "A", { kind: "task", taskStatus: "todo" }));
    const items = Array.from({ length: 201 }, () => one);
    await expect(t.mutation(api.workspace.setNodesCompletion, { ownerKey, completionMode: "dueDate", items })).rejects.toThrow(/at most 200/);
  });
});
