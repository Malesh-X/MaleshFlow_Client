import test from "node:test";
import assert from "node:assert/strict";
import { completionIntentFor, completionStateMatches, withoutLockedNodeIds } from "../lib/domain/workspaceRules";

const state = (over: Partial<Parameters<typeof completionStateMatches>[1]> = {}) => ({
  revision: 5,
  kind: "task",
  taskStatus: "todo",
  noteCompleted: false,
  dueAt: 100,
  dueEndAt: null,
  archived: false,
  ...over,
});

test("completionIntentFor reopens done tasks and completed notes, completes the rest", () => {
  assert.equal(completionIntentFor({ kind: "task", taskStatus: "done" }), "reopen");
  assert.equal(completionIntentFor({ kind: "task", taskStatus: "todo" }), "complete");
  assert.equal(completionIntentFor({ kind: "task", taskStatus: null }), "complete");
  assert.equal(completionIntentFor({ kind: "note", sourceMeta: { noteCompleted: true } }), "reopen");
  assert.equal(completionIntentFor({ kind: "note", sourceMeta: {} }), "complete");
});

test("completionStateMatches ignores revision but not status, dates or archive", () => {
  const seen = { kind: "task", taskStatus: "todo", dueAt: 100, dueEndAt: null };
  assert.equal(completionStateMatches(seen, state({ revision: 9 })), true);
  assert.equal(completionStateMatches({ ...seen, taskStatus: null }, state()), true);
  assert.equal(completionStateMatches(seen, state({ taskStatus: "done" })), false);
  assert.equal(completionStateMatches(seen, state({ dueAt: 200 })), false);
  assert.equal(completionStateMatches(seen, state({ dueEndAt: 150 })), false);
  assert.equal(completionStateMatches(seen, state({ archived: true })), false);
  assert.equal(completionStateMatches(seen, state({ kind: "note", taskStatus: null })), false);
  assert.equal(
    completionStateMatches({ kind: "note", sourceMeta: { noteCompleted: true }, dueAt: null }, state({ kind: "note", taskStatus: null, noteCompleted: false, dueAt: null })),
    false,
  );
});

test("completionStateMatches tells occurrences apart even when status and dates are the same", () => {
  const seen = { kind: "task", taskStatus: "todo", dueAt: 100, dueEndAt: null, sourceMeta: { occurrenceIndex: 2 } };
  assert.equal(completionStateMatches(seen, state({ occurrenceIndex: 2 })), true);
  assert.equal(completionStateMatches(seen, state({ occurrenceIndex: 3 })), false);
  assert.equal(completionStateMatches({ ...seen, sourceMeta: {} }, state({ occurrenceIndex: 0 })), true);
  assert.equal(completionStateMatches({ ...seen, sourceMeta: {} }, state({ occurrenceIndex: 1 })), false);
});

test("withoutLockedNodeIds keeps section headers and planner days out of cuts and moves", () => {
  const nodes: Record<string, { sourceMeta: Record<string, unknown> }> = {
    header: { sourceMeta: { locked: true, sectionSlot: "noteMain" } },
    day: { sourceMeta: { locked: true, plannerKind: "plannerDay" } },
    item: { sourceMeta: {} },
  };
  assert.deepEqual(withoutLockedNodeIds(["header", "item", "day", "missing"], (id) => nodes[id]), ["item", "missing"]);
});
