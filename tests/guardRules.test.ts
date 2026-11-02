import test from "node:test";
import assert from "node:assert/strict";
import {
  GUARD_MODE,
  applyScheduleFixes,
  changeForUpdate,
  checkSchedule,
  isLockedNode,
  nodeEditProblem,
  pageWriteProblem,
  parentProblem,
  scheduleFieldsOf,
} from "../convex/lib/guardRules";

const page = (extra: Record<string, unknown> = {}) => ({ archived: false, sourceMeta: {}, ...extra });
const locked = { sourceMeta: { locked: true, sectionSlot: "noteMain" } };

test("guards ship in record mode", () => {
  assert.equal(GUARD_MODE, "record");
});

test("isLockedNode matches the app's rule", () => {
  assert.equal(isLockedNode(locked), true);
  assert.equal(isLockedNode({ sourceMeta: { locked: true, plannerKind: "plannerDay" } }), true);
  assert.equal(isLockedNode({ sourceMeta: { locked: true } }), false);
  assert.equal(isLockedNode({ sourceMeta: { sectionSlot: "noteMain" } }), false);
  assert.equal(isLockedNode(null), false);
});

test("pageWriteProblem refuses missing, archived and pending-deletion pages", () => {
  assert.equal(pageWriteProblem(page()), null);
  assert.match(pageWriteProblem(null) ?? "", /not found/);
  assert.match(pageWriteProblem(page({ archived: true })) ?? "", /archived/);
  assert.match(pageWriteProblem(page({ sourceMeta: { deletingForever: true } })) ?? "", /being deleted/);
});

test("nodeEditProblem protects locked items from structural changes only", () => {
  for (const change of ["move", "archive", "unarchive", "delete", "kind", "status"] as const) {
    assert.match(nodeEditProblem({ node: locked, page: page(), change }) ?? "", /Section headers/, change);
  }
  for (const change of ["text", "schedule", "other"] as const) {
    assert.equal(nodeEditProblem({ node: locked, page: page(), change }), null, change);
  }
  assert.equal(nodeEditProblem({ node: { sourceMeta: {} }, page: page(), change: "move" }), null);
  assert.match(nodeEditProblem({ node: { sourceMeta: {} }, page: page({ archived: true }), change: "text" }) ?? "", /archived/);
  assert.match(nodeEditProblem({ node: null, page: page(), change: "text" }) ?? "", /not found/);
});

test("parentProblem catches self, cycles, other pages, archived and missing parents", () => {
  const parent = { _id: "p", pageId: "page1", archived: false };
  const base = { nodeId: "n", parentNodeId: "p", parent, pageId: "page1", ancestorIds: [] as string[] };
  assert.equal(parentProblem(base), null);
  assert.equal(parentProblem({ ...base, parentNodeId: null }), null);
  assert.match(parentProblem({ ...base, parentNodeId: "n" }) ?? "", /own parent/);
  assert.match(parentProblem({ ...base, ancestorIds: ["x", "n"] }) ?? "", /loop/);
  assert.match(parentProblem({ ...base, parent: { ...parent, pageId: "page2" } }) ?? "", /different page/);
  assert.match(parentProblem({ ...base, parent: { ...parent, archived: true } }) ?? "", /archived/);
  assert.match(parentProblem({ ...base, parent: null }) ?? "", /doesn't exist/);
  assert.equal(parentProblem({ ...base, nodeId: null, ancestorIds: ["n"] }), null);
});

test("scheduleFieldsOf reads recurrence from sourceMeta and skips absent keys", () => {
  assert.deepEqual(scheduleFieldsOf({ text: "x", dueAt: 5, sourceMeta: { recurrenceFrequency: "daily" } }), { dueAt: 5, recurrenceFrequency: "daily" });
  assert.deepEqual(scheduleFieldsOf({ updatedAt: 1 }), {});
});

test("checkSchedule: a note can't carry a task status", () => {
  const result = checkSchedule({ kind: "note", taskStatus: null }, { taskStatus: "todo" });
  assert.deepEqual(result.fixes, { taskStatus: null });
  assert.equal(result.refusal, null);
  assert.deepEqual(checkSchedule({ kind: "task", taskStatus: null }, { taskStatus: "todo" }).problems, []);
});

test("checkSchedule: clearing the due date clears the other four fields", () => {
  const before = { kind: "task", dueAt: 10, dueEndAt: 20, dueTime: "09:00", dueTimeZone: "UTC", recurrenceFrequency: "daily" };
  const result = checkSchedule(before, { dueAt: null });
  assert.deepEqual(result.fixes, { dueEndAt: null, dueTime: null, dueTimeZone: null, recurrenceFrequency: null });
  assert.deepEqual(checkSchedule(before, { dueAt: null, dueEndAt: null, dueTime: null, dueTimeZone: null, recurrenceFrequency: null }).problems, []);
});

test("checkSchedule: an end date on or before the due date is dropped", () => {
  assert.deepEqual(checkSchedule({ kind: "task", dueAt: 10, dueEndAt: 20 }, { dueAt: 30 }).fixes, { dueEndAt: null });
  assert.deepEqual(checkSchedule({ kind: "task", dueAt: 10 }, { dueEndAt: 10 }).fixes, { dueEndAt: null });
  assert.deepEqual(checkSchedule({ kind: "task", dueAt: 10 }, { dueEndAt: 11 }).fixes, {});
});

test("checkSchedule: recurrence without a due date is refused", () => {
  const result = checkSchedule({ kind: "task", dueAt: null }, { recurrenceFrequency: "weekly" });
  assert.match(result.refusal ?? "", /needs a due date/);
  assert.equal(checkSchedule({ kind: "task", dueAt: 10 }, { recurrenceFrequency: "weekly" }).refusal, null);
  assert.equal(checkSchedule(null, { kind: "task", dueAt: null, recurrenceFrequency: null }).refusal, null);
  assert.deepEqual(checkSchedule(null, { kind: "task", dueAt: null, recurrenceFrequency: "daily" }).problems, ["recurrence without a due date"]);
});

test("checkSchedule ignores untouched or unchanged fields, so old data doesn't trip unrelated edits", () => {
  const bad = { kind: "task", dueAt: null, dueEndAt: 5, recurrenceFrequency: "daily" };
  assert.deepEqual(checkSchedule(bad, {}).problems, []);
  assert.deepEqual(checkSchedule(bad, { recurrenceFrequency: "daily" }).problems, []);
  assert.deepEqual(checkSchedule(bad, { kind: "task" }).problems, []);
});

test("checkSchedule covers creates (no before)", () => {
  const result = checkSchedule(null, { kind: "note", taskStatus: "done", dueAt: 10, dueEndAt: 5 });
  assert.deepEqual(result.fixes, { taskStatus: null, dueEndAt: null });
});

test("applyScheduleFixes writes recurrence into sourceMeta", () => {
  const fixed = applyScheduleFixes({ dueAt: null, text: "x" }, { dueEndAt: null, recurrenceFrequency: null }, { locked: false, recurrenceFrequency: "daily" });
  assert.deepEqual(fixed, { dueAt: null, text: "x", dueEndAt: null, sourceMeta: { locked: false, recurrenceFrequency: null } });
});

test("changeForUpdate picks the most restrictive change", () => {
  const node = { kind: "note", taskStatus: null, sourceMeta: {} };
  assert.equal(changeForUpdate(node, { kind: "task" }), "kind");
  assert.equal(changeForUpdate(node, { kind: "note", text: "x" }), "text");
  assert.equal(changeForUpdate({ ...node, kind: "task" }, { taskStatus: "done" }), "status");
  assert.equal(changeForUpdate(node, { noteCompleted: true }), "status");
  assert.equal(changeForUpdate(node, { dueAt: 5 }), "schedule");
  assert.equal(changeForUpdate(node, {}), "other");
});
