import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  completeNodesInOneCall,
  type CompletionBatchItem,
  type CompletionBatchResult,
} from "../lib/domain/completionBatch";

const tasks = Array.from({ length: 10 }, (_, i) => ({ _id: `n${i}`, kind: "task", taskStatus: "todo", revision: 3 }));
const applied = (items: CompletionBatchItem[]): CompletionBatchResult => ({
  status: "applied",
  message: null,
  conflicts: [],
  results: items.map((item) => ({ nodeId: item.nodeId, status: "applied", receiptId: `r-${item.nodeId}`, movesItem: false })),
  receiptIds: items.map((item) => `r-${item.nodeId}`),
});
const state = (revision: number, taskStatus: string) => ({
  revision, kind: "task", taskStatus, noteCompleted: false, dueAt: null, dueEndAt: null, occurrenceIndex: 0, archived: false,
});

test("checking off ten selected items sends exactly one mutation", async () => {
  const calls: CompletionBatchItem[][] = [];
  const result = await completeNodesInOneCall(tasks, async (items) => {
    calls.push(items);
    return applied(items);
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.length, 10);
  assert.deepEqual(calls[0]![0], { nodeId: "n0", intent: "complete", expectedRevision: 3 });
  assert.equal(result.receiptIds.length, 10);
});

test("a stale batch after a text edit is retried once with the server's revisions", async () => {
  const calls: CompletionBatchItem[][] = [];
  await completeNodesInOneCall(tasks, async (items) => {
    calls.push(items);
    if (calls.length === 1) {
      return { status: "stale", message: "x", conflicts: [{ nodeId: "n4", before: state(4, "todo") }], results: [], receiptIds: [] };
    }
    return applied(items);
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1]!.find((item) => item.nodeId === "n4")!.expectedRevision, 4);
  assert.equal(calls[1]!.find((item) => item.nodeId === "n0")!.expectedRevision, 3);
});

test("a batch refused because an item was completed elsewhere is not retried", async () => {
  let calls = 0;
  const result = await completeNodesInOneCall(tasks, async () => {
    calls += 1;
    return { status: "stale", message: "1 item changed", conflicts: [{ nodeId: "n4", before: state(4, "done") }], results: [], receiptIds: [] };
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "stale");
});

// Cmd+Enter on a selection goes through the batch, not one setNodeCompletion per item.
test("Cmd+Enter on a selection makes one setNodesCompletion call", () => {
  const source = readFileSync(new URL("../components/WorkspaceApp.tsx", import.meta.url), "utf8");
  const start = source.indexOf("const toggleHighlightedNodeCompletion = useCallback(");
  const body = source.slice(start, source.indexOf("\n  }, [", start));
  assert.ok(start > 0);
  assert.equal(body.match(/await completeNodes\(/g)?.length, 1);
  assert.ok(!/completeNode\(/.test(body), "the selection must not complete items one at a time");
});
