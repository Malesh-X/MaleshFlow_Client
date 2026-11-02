/// <reference types="vite/client" />
// workspace:setNodeCompletion (Phase 3, change 2): explicit intent, revision
// checks, planner occurrence tokens, and the legacy adapters.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { appendPlannerDayCore, appendPlannerLinkedTaskCopy } from "../convex/lib/planner";
import schema from "../convex/schema";
import { zonedNoon } from "../lib/domain/timeZone";
import { completionStateMatches } from "../lib/domain/workspaceRules";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";
const HNL = "Pacific/Honolulu";
const day = (d: number) => zonedNoon({ year: 2026, month: 11, day: d }, HNL);

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T20:00:00Z")); // 10 a.m. Nov 2 in Honolulu
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = convexTest(schema, modules);
  await t.mutation(api.workspace.setWorkspaceSettings, { ownerKey, timeZone: HNL });
  const get = (id: Id<"nodes">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"nodes">>;
  const complete = async (
    nodeId: Id<"nodes">,
    intent: "complete" | "reopen" = "complete",
    extra: { completionMode?: "dueDate" | "today"; expectedRevision?: number; plannerPageId?: Id<"pages"> } = {},
  ) =>
    t.mutation(api.workspace.setNodeCompletion, {
      ownerKey,
      nodeId,
      intent,
      completionMode: extra.completionMode ?? "dueDate",
      expectedRevision: extra.expectedRevision ?? ((await get(nodeId)).revision ?? 0),
      ...(extra.plannerPageId ? { plannerPageId: extra.plannerPageId } : {}),
    });
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
    );
  return { t, get, complete, page, add, planner, linkCopy };
}

describe("intent and revision", () => {
  test("complete and reopen are idempotent; complete never reopens", async () => {
    const { get, complete, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Task", { kind: "task", taskStatus: "todo" });
    expect((await complete(task)).status).toBe("applied");
    expect((await get(task)).taskStatus).toBe("done");
    expect(await complete(task)).toMatchObject({ status: "noop" });
    expect((await get(task)).taskStatus).toBe("done");
    expect(await complete(task, "reopen")).toMatchObject({ status: "applied", route: "task" });
    expect((await get(task)).taskStatus).toBe("todo");
    expect(await complete(task, "reopen")).toMatchObject({ status: "noop" });
  });

  test("a stale revision changes nothing and returns the current state", async () => {
    const { t, get, complete, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Task", { kind: "task", taskStatus: "todo" });
    const seen = (await get(task)).revision!;
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: task, text: "edited elsewhere" });
    const result = await complete(task, "complete", { expectedRevision: seen });
    expect(result.status).toBe("stale");
    expect(result.after?.revision).toBe(seen + 1);
    expect((await get(task)).taskStatus).toBe("todo");
  });

  test("notes get the completed flag", async () => {
    const { get, complete, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const note = await add(pageId, "Note");
    expect(await complete(note)).toMatchObject({ status: "applied", route: "note" });
    expect(((await get(note)).sourceMeta as Record<string, unknown>).noteCompleted).toBe(true);
    expect(await complete(note)).toMatchObject({ status: "noop" });
  });

  test("completing a future recurring task from today twice with the same revision changes it once", async () => {
    const { get, complete, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    // Due Nov 3, daily; "today" mode on Nov 2 gives Nov 3 again: the due date alone can't tell the calls apart.
    const task = await add(pageId, "Daily", { kind: "task", taskStatus: "todo", dueAt: day(3), recurrenceFrequency: "daily" });
    const seen = (await get(task)).revision!;
    expect((await complete(task, "complete", { completionMode: "today", expectedRevision: seen })).status).toBe("applied");
    const afterFirst = await get(task);
    expect(afterFirst.dueAt).toBe(day(3));
    expect((afterFirst.sourceMeta as Record<string, unknown>).occurrenceIndex).toBe(1);
    const replay = await complete(task, "complete", { completionMode: "today", expectedRevision: seen });
    expect(replay.status).toBe("stale");
    const afterReplay = await get(task);
    expect(afterReplay.revision).toBe(afterFirst.revision);
    expect((afterReplay.sourceMeta as Record<string, unknown>).occurrenceIndex).toBe(1);
  });
});

// The app's retry rule (WorkspaceApp setNodeCompletionChecked): a stale
// answer is retried once with the server's revision when the item still
// looks the way the caller saw it.
async function appComplete(
  t: Awaited<ReturnType<typeof setup>>["t"],
  seen: Doc<"nodes">,
  completionMode: "dueDate" | "today",
) {
  const args = { ownerKey, nodeId: seen._id, intent: "complete" as const, completionMode, expectedRevision: seen.revision ?? 0 };
  const first = await t.mutation(api.workspace.setNodeCompletion, args);
  if (first.status !== "stale" || !completionStateMatches(seen, first.before)) return first;
  return t.mutation(api.workspace.setNodeCompletion, { ...args, expectedRevision: first.before.revision });
}

describe("double completion", () => {
  for (const completionMode of ["dueDate", "today"] as const) {
    test(`two app requests against the same revision complete the occurrence once (${completionMode})`, async () => {
      const { t, get, page, add } = await setup();
      const pageId = await page("Plain", "Notes", "note");
      // Due Nov 3, daily: in "today" mode on Nov 2 the due date stays Nov 3.
      const task = await add(pageId, "Daily", { kind: "task", taskStatus: "todo", dueAt: day(3), recurrenceFrequency: "daily" });
      const seen = await get(task);
      expect((await appComplete(t, seen, completionMode)).status).toBe("applied");
      const afterFirst = await get(task);
      const second = await appComplete(t, seen, completionMode);
      expect(second.status).not.toBe("applied");
      // The current state comes back, and nothing changed.
      expect(second.after?.revision).toBe(afterFirst.revision);
      const afterSecond = await get(task);
      expect((afterSecond.sourceMeta as Record<string, unknown>).occurrenceIndex).toBe(1);
      expect(afterSecond.revision).toBe(afterFirst.revision);
    });
  }
});

describe("same-page planner preview", () => {
  test("a sidebar task completed through its preview in a planner day completes the planner copy and advances the source", async () => {
    const { t, get, complete, page, add } = await setup();
    const pageId = await page("Plan", "Tasks", "planner");
    await t.mutation(api.planner.ensurePlannerPageSections, { ownerKey, pageId });
    const dayId = (await t.run(async (ctx) => appendPlannerDayCore(ctx, { page: (await ctx.db.get(pageId))!, plannerDate: day(2) })))
      .dayNodeId as Id<"nodes">;
    const sidebar = (await t.run((ctx) => ctx.db.query("nodes").collect())).find(
      (n) => n.pageId === pageId && (n.sourceMeta as Record<string, unknown> | undefined)?.sectionSlot === "plannerSidebar",
    )!._id;
    const source = await add(pageId, "Daily", { kind: "task", taskStatus: "todo", dueAt: day(2), recurrenceFrequency: "daily", parentNodeId: sidebar });
    const copy = (await t.run(async (ctx) =>
      appendPlannerLinkedTaskCopy(ctx, {
        plannerPageId: pageId,
        parentNodeId: dayId,
        plannerDate: day(2),
        sourceTask: { ...(await ctx.db.get(source))!, dueEndAt: null },
        afterNodeId: null,
      }),
    )) as Id<"nodes">;

    const result = await complete(source, "complete", { plannerPageId: pageId });
    expect(result).toMatchObject({ status: "applied", route: "plannerPreview" });
    const copyAfter = await get(copy);
    expect(copyAfter.taskStatus).toBe("done");
    expect(copyAfter.archived).toBe(true);
    const sourceAfter = await get(source);
    expect(sourceAfter.dueAt).toBe(day(3));
    expect((sourceAfter.sourceMeta as Record<string, unknown>).occurrenceIndex).toBe(1);
  });
});

describe("app callers", () => {
  test("the page tree the app loads carries each item's revision", async () => {
    const { t, get, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Task", { kind: "task", taskStatus: "todo" });
    const tree = await t.query(api.workspace.getPageTree, { ownerKey, pageId });
    const loaded = tree!.nodes.find((node: { _id: string }) => node._id === task) as { revision?: number };
    expect(loaded.revision).toBe((await get(task)).revision);
  });

  test("after a text edit the app's retry completes once; a completion elsewhere is not repeated", async () => {
    const { t, get, complete, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Task", { kind: "task", taskStatus: "todo" });
    const seen = await get(task);
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: task, text: "Task, edited" });
    const stale = await complete(task, "complete", { expectedRevision: seen.revision ?? 0 });
    expect(stale.status).toBe("stale");
    // Same status and dates as the app saw: the app retries with the server's revision.
    expect(completionStateMatches(seen, stale.before)).toBe(true);
    expect((await complete(task, "complete", { expectedRevision: stale.before.revision })).status).toBe("applied");
    // A second tab that saw the open task gets stale again, and its view no longer matches.
    const second = await complete(task, "complete", { expectedRevision: seen.revision ?? 0 });
    expect(second.status).toBe("stale");
    expect(completionStateMatches(seen, second.before)).toBe(false);
  });
});

describe("routing", () => {
  test("task page with a Done archive moves the finished root to Done", async () => {
    const { t, get, complete, page, add } = await setup();
    const pageId = await page("Tasks", "Tasks", "task");
    await t.mutation(api.workspace.setTaskPageDoneArchiveEnabled, { ownerKey, pageId, enabled: true });
    const task = await add(pageId, "Ship it", { kind: "task", taskStatus: "todo" });
    const result = await complete(task);
    expect(result).toMatchObject({ status: "applied", route: "taskPage" });
    expect(result.receipt?.archivedRootNodeId).toBe(task);
    expect((await get(task)).archived).toBe(true);
    expect(await complete(task)).toMatchObject({ status: "noop" });
  });

  test("recurring tasks roll forward and bump their occurrence", async () => {
    const { get, complete, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Weekly", { kind: "task", taskStatus: "todo", dueAt: day(2), recurrenceFrequency: "weekly" });
    expect(await complete(task)).toMatchObject({ status: "applied", route: "recurring" });
    const after = await get(task);
    expect(after.taskStatus).toBe("todo");
    expect(after.dueAt).toBe(day(9));
    expect((after.sourceMeta as Record<string, unknown>).occurrenceIndex).toBe(1);
  });

  test("planner items take the planner path; previews complete the planner's copy", async () => {
    const { get, complete, page, add, planner, linkCopy } = await setup();
    const tasks = await page("Tasks", "Tasks", "task");
    const source = await add(tasks, "Source", { kind: "task", taskStatus: "todo", dueAt: day(2) });
    const plan = await planner("Plan", day(2));
    const copy = await linkCopy(plan.pageId, plan.dayId, day(2), source);
    const viaPreview = await complete(source, "complete", { plannerPageId: plan.pageId });
    expect(viaPreview).toMatchObject({ status: "applied", route: "plannerPreview" });
    expect((await get(copy)).taskStatus).toBe("done");
    const item = await add(plan.pageId, "Plan item", { kind: "task", taskStatus: "todo", parentNodeId: plan.dayId });
    expect(await complete(item)).toMatchObject({ status: "applied", route: "planner" });
  });
});

describe("occurrence tokens", () => {
  test("acceptance: the same recurring occurrence in two planners advances the source exactly once, even if the second planner refreshes in between", async () => {
    const { t, get, complete, page, add, planner, linkCopy } = await setup();
    const tasks = await page("Tasks", "Tasks", "task");
    const source = await add(tasks, "Daily", { kind: "task", taskStatus: "todo", dueAt: day(2), recurrenceFrequency: "daily" });
    const one = await planner("Planner one", day(2));
    const two = await planner("Planner two", day(2));
    const copyOne = await linkCopy(one.pageId, one.dayId, day(2), source);
    const copyTwo = await linkCopy(two.pageId, two.dayId, day(2), source);
    expect(((await get(copyOne)).sourceMeta as Record<string, unknown>).sourceOccurrenceToken).toBe("0");
    expect(((await get(copyTwo)).sourceMeta as Record<string, unknown>).sourceOccurrenceToken).toBe("0");

    await complete(copyOne);
    const afterFirst = await get(source);
    expect(afterFirst.dueAt).toBe(day(3));
    expect((afterFirst.sourceMeta as Record<string, unknown>).occurrenceIndex).toBe(1);

    // Refresh the second planner: add its next day and re-run section setup.
    await t.mutation(api.planner.appendPlannerDay, { ownerKey, pageId: two.pageId });
    await t.mutation(api.planner.ensurePlannerPageSections, { ownerKey, pageId: two.pageId });
    expect(((await get(copyTwo)).sourceMeta as Record<string, unknown>).sourceOccurrenceToken).toBe("0");

    await complete(copyTwo);
    const afterSecond = await get(source);
    expect(afterSecond.dueAt).toBe(day(3));
    expect((afterSecond.sourceMeta as Record<string, unknown>).occurrenceIndex).toBe(1);
    expect((await get(copyTwo)).taskStatus).toBe("done");
  });

  test("legacy copies without a token keep today's behavior", async () => {
    const { t, get, complete, page, add, planner, linkCopy } = await setup();
    const tasks = await page("Tasks", "Tasks", "task");
    const source = await add(tasks, "Daily", { kind: "task", taskStatus: "todo", dueAt: day(2), recurrenceFrequency: "daily" });
    const one = await planner("One", day(2));
    const two = await planner("Two", day(2));
    const copyOne = await linkCopy(one.pageId, one.dayId, day(2), source);
    const copyTwo = await linkCopy(two.pageId, two.dayId, day(2), source);
    for (const copy of [copyOne, copyTwo]) {
      await t.run(async (ctx) => {
        const node = (await ctx.db.get(copy))!;
        const meta = { ...(node.sourceMeta as Record<string, unknown>) };
        delete meta.sourceOccurrenceToken;
        await ctx.db.patch(copy, { sourceMeta: meta });
      });
    }
    await complete(copyOne);
    await complete(copyTwo);
    expect((await get(source)).dueAt).toBe(day(4));
  });

  test("undo restores the occurrence, so completing again advances once more", async () => {
    const { t, get, complete, page, add, planner, linkCopy } = await setup();
    const tasks = await page("Tasks", "Tasks", "task");
    const source = await add(tasks, "Daily", { kind: "task", taskStatus: "todo", dueAt: day(2), recurrenceFrequency: "daily" });
    const plan = await planner("Plan", day(2));
    const copy = await linkCopy(plan.pageId, plan.dayId, day(2), source);
    const result = await complete(copy);
    expect((await get(source)).dueAt).toBe(day(3));
    await t.mutation(api.planner.undoCompletePlannerTask, { ownerKey, receipt: result.receipt! });
    const undone = await get(source);
    expect(undone.dueAt).toBe(day(2));
    expect((undone.sourceMeta as Record<string, unknown>).occurrenceIndex).toBe(0);
    await complete(copy);
    expect((await get(source)).dueAt).toBe(day(3));
  });
});

describe("legacy adapters", () => {
  test("old tabs' mutations keep today's behavior", async () => {
    const { t, get, page, add, planner } = await setup();
    const tasks = await page("Tasks", "Tasks", "task");
    await t.mutation(api.workspace.setTaskPageDoneArchiveEnabled, { ownerKey, pageId: tasks, enabled: false });
    const task = await add(tasks, "Toggle", { kind: "task", taskStatus: "todo" });
    await t.mutation(api.workspace.completeTaskPageTask, { ownerKey, nodeId: task, completionMode: "dueDate" });
    expect((await get(task)).taskStatus).toBe("done");
    // completeTaskPageTask toggles, as before.
    await t.mutation(api.workspace.completeTaskPageTask, { ownerKey, nodeId: task, completionMode: "dueDate" });
    expect((await get(task)).taskStatus).toBe("todo");
    const plan = await planner("Plan", day(2));
    const item = await add(plan.pageId, "Item", { kind: "task", taskStatus: "todo", parentNodeId: plan.dayId });
    await t.mutation(api.planner.completePlannerTask, { ownerKey, plannerNodeId: item, completionMode: "dueDate" });
    expect((await get(item)).taskStatus).toBe("done");
  });
});

// Prod regression after Phase 3: checking off items in older data.
describe("older data", () => {
  test("items with no revision field complete with expectedRevision 0 on every page kind", async () => {
    const { t, get, page, add, planner } = await setup();
    const notePage = await page("Notes", "Notes", "note");
    const taskPage = await page("Tasks", "Tasks", "task");
    const plan = await planner("Plan", day(2));
    const items = [
      await add(notePage, "Plain task", { kind: "task", taskStatus: "todo" }),
      await add(notePage, "A note", { kind: "note" }),
      await add(taskPage, "Task page task", { kind: "task", taskStatus: "todo" }),
      await add(plan.pageId, "Planner task", { kind: "task", taskStatus: "todo", parentNodeId: plan.dayId }),
    ];
    for (const id of items) {
      await t.run(async (ctx) => {
        const { _id, _creationTime, revision: _revision, ...rest } = (await ctx.db.get(id))!;
        await ctx.db.replace(id, rest);
      });
      expect((await get(id)).revision).toBeUndefined();
      const result = await t.mutation(api.workspace.setNodeCompletion, {
        ownerKey, nodeId: id, intent: "complete", completionMode: "dueDate", expectedRevision: 0,
      });
      expect(result.status).toBe("applied");
    }
  });

  test("a workspace with no saved settings can complete items", async () => {
    const t = convexTest(schema, modules);
    const pageId = await t.mutation(api.workspace.createPage, { ownerKey, title: "P", sidebarSection: "Notes", pageType: "note" });
    const task = await t.mutation(api.workspace.createNode, { ownerKey, pageId, text: "T", kind: "task", taskStatus: "todo" });
    const result = await t.mutation(api.workspace.setNodeCompletion, {
      ownerKey, nodeId: task, intent: "complete", completionMode: "today",
      expectedRevision: (await t.run((ctx) => ctx.db.get(task)))!.revision ?? 0,
    });
    expect(result.status).toBe("applied");
  });
});
