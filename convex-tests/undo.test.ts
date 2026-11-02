/// <reference types="vite/client" />
// Stored, conflict-checked undo receipts (Phase 4): workspace:undoCompletion,
// workspace:redoCompletion, chains, and the legacy planner:undoCompletePlannerTask.
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../convex/_generated/api";
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
  const get = (id: Id<"nodes">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"nodes"> | null>;
  const meta = async (id: Id<"nodes">) => ((await get(id))?.sourceMeta ?? {}) as Record<string, unknown>;
  const complete = async (nodeId: Id<"nodes">, extra: { plannerPageId?: Id<"pages"> } = {}) => {
    const result = await t.mutation(api.workspace.setNodeCompletion, {
      ownerKey,
      nodeId,
      intent: "complete",
      completionMode: "dueDate",
      expectedRevision: (await get(nodeId))?.revision ?? 0,
      ...extra,
    });
    expect(result.status).toBe("applied");
    expect(result.receiptId).toBeTruthy();
    return result;
  };
  const undo = (...receiptIds: (string | null)[]) => t.mutation(api.workspace.undoCompletion, { ownerKey, receiptIds: receiptIds as string[] });
  const redo = (...receiptIds: (string | null)[]) => t.mutation(api.workspace.redoCompletion, { ownerKey, receiptIds: receiptIds as string[] });
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
  return { t, get, meta, complete, undo, redo, page, add, planner, linkCopy };
}

// The message of an undoRefused ConvexError.
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConvexError);
    const data = (error as ConvexError<{ code: string; message: string }>).data;
    expect(data.code).toBe("undoRefused");
    return data.message;
  }
  throw new Error("Expected the undo to be refused.");
}

describe("checked undo", () => {
  test("undo and redo of a plain task pass when nothing changed", async () => {
    const { get, complete, undo, redo, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Task", { kind: "task", taskStatus: "todo" });
    const done = await complete(task);
    expect(done.receipt).toBeNull(); // old tabs undo plain tasks with updateNode
    await undo(done.receiptId);
    expect((await get(task))!.taskStatus).toBe("todo");
    await redo(done.receiptId);
    expect((await get(task))!.taskStatus).toBe("done");
    await undo(done.receiptId);
    expect((await get(task))!.taskStatus).toBe("todo");
  });

  test("add a child, then undo the completion: refused, nothing changes", async () => {
    const { t, get, complete, undo, page, add } = await setup();
    const tasks = await page("Tasks", "Tasks", "task");
    await t.mutation(api.workspace.setTaskPageDoneArchiveEnabled, { ownerKey, pageId: tasks, enabled: true });
    const task = await add(tasks, "Ship it", { kind: "task", taskStatus: "todo" });
    const done = await complete(task);
    const copyId = done.receipt!.pastWeeksCloneRootNodeId as Id<"nodes">;
    const copy = (await get(copyId))!;
    // The Done copy gets a child after the completion. Adding a child doesn't
    // change the copy's revision; only the membership check catches it.
    const revisionBefore = copy.revision;
    const child = await add(copy.pageId, "Follow-up note", { parentNodeId: copyId });
    expect((await get(copyId))!.revision).toBe(revisionBefore);

    const message = await refusal(undo(done.receiptId));
    expect(message).toContain(`"Follow-up note" was added under "Ship it"`);
    expect(message).toContain("Nothing was undone");
    expect(await get(child)).not.toBeNull();
    expect(await get(copyId)).not.toBeNull();
    expect((await get(task))!.archived).toBe(true);
  });

  test("an unrelated edit, then undo: refused", async () => {
    const { t, get, complete, undo, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Water plants", { kind: "task", taskStatus: "todo" });
    const done = await complete(task);
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: task, text: "Water the plants" });
    const message = await refusal(undo(done.receiptId));
    expect(message).toContain(`"Water the plants" was changed`);
    expect((await get(task))!.taskStatus).toBe("done");
  });

  test("a deleted item is named", async () => {
    const { t, complete, undo, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Temporary", { kind: "task", taskStatus: "todo" });
    const done = await complete(task);
    await t.mutation(api.workspace.deleteNode, { ownerKey, nodeId: task });
    expect(await refusal(undo(done.receiptId))).toContain(`"Temporary" was deleted`);
  });

  test("undo twice is refused; redo before undo is refused", async () => {
    const { complete, undo, redo, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Task", { kind: "task", taskStatus: "todo" });
    const done = await complete(task);
    expect(await refusal(redo(done.receiptId))).toContain("hasn't been undone");
    await undo(done.receiptId);
    expect(await refusal(undo(done.receiptId))).toContain("already undone");
  });

  test("an edit after the undo makes redo refuse", async () => {
    const { t, get, complete, undo, redo, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Task", { kind: "task", taskStatus: "todo" });
    const done = await complete(task);
    await undo(done.receiptId);
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: task, text: "Task, renamed" });
    expect(await refusal(redo(done.receiptId))).toContain(`"Task, renamed" was changed`);
    expect((await get(task))!.taskStatus).toBe("todo");
  });

  test("several receipts undo all or nothing", async () => {
    const { t, get, complete, undo, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const one = await add(pageId, "One", { kind: "task", taskStatus: "todo" });
    const two = await add(pageId, "Two", { kind: "task", taskStatus: "todo" });
    const first = await complete(one);
    const second = await complete(two);
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: one, text: "One, edited" });
    await refusal(undo(second.receiptId, first.receiptId));
    expect((await get(two))!.taskStatus).toBe("done");
    expect((await get(one))!.taskStatus).toBe("done");
  });

  test("a planner item archived to Past Weeks comes back, and the copy is removed", async () => {
    const { get, complete, undo, redo, add, planner } = await setup();
    const plan = await planner("Plan", day(2));
    const item = await add(plan.pageId, "Plan item", { kind: "task", taskStatus: "todo", parentNodeId: plan.dayId });
    const child = await add(plan.pageId, "Step", { kind: "task", taskStatus: "done", parentNodeId: item });
    const done = await complete(item);
    expect(done.route).toBe("planner");
    expect(done.receipt!.archivedRootNodeId).toBe(item);
    expect((await get(item))!.archived).toBe(true);
    expect((await get(child))!.archived).toBe(true);
    const copyId = done.receipt!.pastWeeksCloneRootNodeId as Id<"nodes">;
    expect(await get(copyId)).not.toBeNull();
    await undo(done.receiptId);
    expect((await get(item))!.archived).toBe(false);
    expect((await get(child))!.archived).toBe(false);
    expect((await get(item))!.taskStatus).toBe("todo");
    expect(await get(copyId)).toBeNull();
    await redo(done.receiptId);
    expect((await get(item))!.archived).toBe(true);
    await undo(done.receiptId);
    expect((await get(item))!.archived).toBe(false);
  });

  test("a no-op AI classification doesn't bump the revision, so undo still passes", async () => {
    const { t, get, complete, undo, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Plain task", { kind: "task", taskStatus: "todo" });
    const done = await complete(task);
    const revision = (await get(task))!.revision;
    await t.mutation(internal.aiData.applyTaskMetadata, { nodeId: task, kind: "task", taskStatus: "done", priority: null });
    expect((await get(task))!.revision).toBe(revision);
    await undo(done.receiptId);
  });
});

describe("redo replays the original intent", () => {
  test("complete, reopen, undo the reopen, redo: the task ends up reopened", async () => {
    const { t, get, complete, undo, redo, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Task", { kind: "task", taskStatus: "todo" });
    await complete(task);
    const reopened = await t.mutation(api.workspace.setNodeCompletion, {
      ownerKey, nodeId: task, intent: "reopen", completionMode: "dueDate", expectedRevision: (await get(task))!.revision ?? 0,
    });
    expect(reopened.status).toBe("applied");
    expect((await get(task))!.taskStatus).toBe("todo");
    await undo(reopened.receiptId);
    expect((await get(task))!.taskStatus).toBe("done");
    await redo(reopened.receiptId);
    expect((await get(task))!.taskStatus).toBe("todo");
  });
});

// The app's one-step "edit the text, then check the box": undo runs the
// completion undo, then the text undo; redo runs the text redo, then the
// completion redo, passing on the revisions its own text undo and redo wrote.
describe("text edit plus completion in one history step", () => {
  async function editThenComplete() {
    const s = await setup();
    const pageId = await s.page("Plain", "Notes", "note");
    const task = await s.add(pageId, "Draft", { kind: "task", taskStatus: "todo" });
    await s.t.mutation(api.workspace.updateNode, { ownerKey, nodeId: task, text: "Draft, edited" });
    const done = await s.complete(task);
    await s.undo(done.receiptId);
    const undoWrite = (await s.t.mutation(api.workspace.updateNode, { ownerKey, nodeId: task, text: "Draft" }))!;
    expect((await s.get(task))!.taskStatus).toBe("todo");
    const redoText = () => s.t.mutation(api.workspace.updateNode, { ownerKey, nodeId: task, text: "Draft, edited" });
    const redoCompletion = (ownWrites: { nodeId: Id<"nodes">; revisionBefore: number; revision: number }[]) =>
      s.t.mutation(api.workspace.redoCompletion, { ownerKey, receiptIds: [done.receiptId!], ownWrites: [undoWrite, ...ownWrites] });
    return { ...s, task, redoText, redoCompletion };
  }

  test("after undo, redo leaves the text redone and the task completed", async () => {
    const { get, task, redoText, redoCompletion } = await editThenComplete();
    const write = await redoText();
    await redoCompletion([write!]);
    const after = (await get(task))!;
    expect(after.text).toBe("Draft, edited");
    expect(after.taskStatus).toBe("done");
  });

  test("another tab's edit before the text redo still makes the redo refuse", async () => {
    const { t, get, task, redoText, redoCompletion } = await editThenComplete();
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: task, priority: "high" });
    const write = await redoText();
    await refusal(redoCompletion([write!]));
    expect((await get(task))!.taskStatus).toBe("todo");
  });

  test("without the app's own writes the redo refuses, as before", async () => {
    const { t, get, task, redoText } = await editThenComplete();
    await redoText();
    const receipts = await t.run((ctx) => ctx.db.query("undoReceipts").collect());
    await refusal(t.mutation(api.workspace.redoCompletion, { ownerKey, receiptIds: [receipts[0]!._id] }));
    expect((await get(task))!.taskStatus).toBe("todo");
  });

  test("another tab's edit after the text redo still makes the redo refuse", async () => {
    const { t, get, task, redoText, redoCompletion } = await editThenComplete();
    const write = await redoText();
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: task, priority: "high" });
    await refusal(redoCompletion([write!]));
    expect((await get(task))!.taskStatus).toBe("todo");
  });
});

describe("chains", () => {
  test("complete the same recurring task twice, undo twice, then redo twice: every step passes", async () => {
    const { get, meta, complete, undo, redo, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Weekly", { kind: "task", taskStatus: "todo", dueAt: day(2), recurrenceFrequency: "weekly" });
    const a = await complete(task);
    const b = await complete(task);
    expect((await get(task))!.dueAt).toBe(day(16));
    expect((await meta(task)).occurrenceIndex).toBe(2);

    await undo(b.receiptId);
    expect((await get(task))!.dueAt).toBe(day(9));
    await undo(a.receiptId);
    expect((await get(task))!.dueAt).toBe(day(2));
    expect((await meta(task)).occurrenceIndex ?? 0).toBe(0);

    await redo(a.receiptId);
    expect((await get(task))!.dueAt).toBe(day(9));
    await redo(b.receiptId);
    expect((await get(task))!.dueAt).toBe(day(16));
    expect((await meta(task)).occurrenceIndex).toBe(2);

    // And back again.
    await undo(b.receiptId);
    await undo(a.receiptId);
    expect((await get(task))!.dueAt).toBe(day(2));
  });

  test("an edit between two undos breaks the chain", async () => {
    const { t, get, complete, undo, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Weekly", { kind: "task", taskStatus: "todo", dueAt: day(2), recurrenceFrequency: "weekly" });
    const a = await complete(task);
    const b = await complete(task);
    await undo(b.receiptId);
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: task, priority: "high" });
    expect(await refusal(undo(a.receiptId))).toContain(`"Weekly" was changed`);
    expect((await get(task))!.dueAt).toBe(day(9));
  });

  test("undoing in the wrong order is refused", async () => {
    const { complete, undo, page, add } = await setup();
    const pageId = await page("Plain", "Notes", "note");
    const task = await add(pageId, "Weekly", { kind: "task", taskStatus: "todo", dueAt: day(2), recurrenceFrequency: "weekly" });
    const a = await complete(task);
    await complete(task);
    expect(await refusal(undo(a.receiptId))).toContain(`"Weekly" was changed`);
  });

  test("two planners: the source advances exactly once, and undo and redo of both copies keep it that way", async () => {
    const { get, meta, complete, undo, redo, page, add, planner, linkCopy } = await setup();
    const tasks = await page("Tasks", "Tasks", "task");
    const source = await add(tasks, "Daily", { kind: "task", taskStatus: "todo", dueAt: day(2), recurrenceFrequency: "daily" });
    const one = await planner("Planner one", day(2));
    const two = await planner("Planner two", day(2));
    const copyOne = await linkCopy(one.pageId, one.dayId, day(2), source);
    const copyTwo = await linkCopy(two.pageId, two.dayId, day(2), source);

    const first = await complete(copyOne);
    const second = await complete(copyTwo);
    expect((await get(source))!.dueAt).toBe(day(3));
    expect((await meta(source)).occurrenceIndex).toBe(1);

    await undo(second.receiptId, first.receiptId);
    expect((await get(source))!.dueAt).toBe(day(2));
    expect((await meta(source)).occurrenceIndex).toBe(0);
    expect((await get(copyOne))!.taskStatus).toBe("todo");
    expect((await get(copyTwo))!.taskStatus).toBe("todo");

    await redo(first.receiptId, second.receiptId);
    expect((await get(source))!.dueAt).toBe(day(3));
    expect((await meta(source)).occurrenceIndex).toBe(1);
    expect((await get(copyOne))!.taskStatus).toBe("done");
    expect((await get(copyTwo))!.taskStatus).toBe("done");
  });
});

describe("legacy adapter", () => {
  test("old tabs' undo with a stored receipt id is checked", async () => {
    const { t, get, complete, page, add } = await setup();
    const tasks = await page("Tasks", "Tasks", "task");
    await t.mutation(api.workspace.setTaskPageDoneArchiveEnabled, { ownerKey, pageId: tasks, enabled: true });
    const task = await add(tasks, "Ship it", { kind: "task", taskStatus: "todo" });
    const done = await complete(task);
    expect(done.receipt?.receiptId).toBe(done.receiptId);
    const copyId = done.receipt!.pastWeeksCloneRootNodeId as Id<"nodes">;
    const copy = (await get(copyId))!;
    await add(copy.pageId, "Added later", { parentNodeId: copyId });
    await refusal(t.mutation(api.planner.undoCompletePlannerTask, { ownerKey, receipt: done.receipt! }));
    expect((await get(task))!.archived).toBe(true);
  });

  test("old tabs' undo with a receipt id passes when nothing changed", async () => {
    const { t, get, complete, page, add } = await setup();
    const tasks = await page("Tasks", "Tasks", "task");
    await t.mutation(api.workspace.setTaskPageDoneArchiveEnabled, { ownerKey, pageId: tasks, enabled: true });
    const task = await add(tasks, "Ship it", { kind: "task", taskStatus: "todo" });
    const done = await complete(task);
    await t.mutation(api.planner.undoCompletePlannerTask, { ownerKey, receipt: done.receipt! });
    expect((await get(task))!.archived).toBe(false);
    expect((await get(task))!.taskStatus).toBe("todo");
    expect(await get(done.receipt!.pastWeeksCloneRootNodeId as Id<"nodes">)).toBeNull();
  });

  test("receipts from before Phase 4 (no receipt id) still restore, unchecked", async () => {
    const { t, get, complete, page, add } = await setup();
    const tasks = await page("Tasks", "Tasks", "task");
    await t.mutation(api.workspace.setTaskPageDoneArchiveEnabled, { ownerKey, pageId: tasks, enabled: true });
    const task = await add(tasks, "Ship it", { kind: "task", taskStatus: "todo" });
    const done = await complete(task);
    // A receipt as an old tab got it: the same fields, no receiptId.
    const oldReceipt = Object.fromEntries(Object.entries(done.receipt!).filter(([key]) => key !== "receiptId")) as typeof done.receipt & object;
    await t.mutation(api.planner.undoCompletePlannerTask, { ownerKey, receipt: oldReceipt });
    expect((await get(task))!.archived).toBe(false);
    expect((await get(task))!.taskStatus).toBe("todo");
  });

  test("force archive returns a stored receipt that undo and redo use", async () => {
    const { t, get, undo, redo, page, add } = await setup();
    const tasks = await page("Tasks", "Tasks", "task");
    await t.mutation(api.workspace.setTaskPageDoneArchiveEnabled, { ownerKey, pageId: tasks, enabled: true });
    const task = await add(tasks, "Not done yet", { kind: "task", taskStatus: "todo" });
    const result = await t.mutation(api.workspace.forceArchiveTaskPageItem, { ownerKey, nodeId: task });
    expect((await get(task))!.archived).toBe(true);
    await undo(result.receiptId);
    expect((await get(task))!.archived).toBe(false);
    await redo(result.receiptId);
    expect((await get(task))!.archived).toBe(true);
  });
});
