import test from "node:test";
import assert from "node:assert/strict";
import { parseNodeDraft, parseNodeDraftWithFallback } from "../lib/domain/nodeDraft";

test("parseNodeDraft reads checkboxes, dimming, separators and empty text", () => {
  assert.deepEqual(parseNodeDraft("  [ ] buy milk "), { shouldDelete: false, text: "buy milk", kind: "task", taskStatus: "todo" });
  assert.deepEqual(parseNodeDraft("[X] done thing"), { shouldDelete: false, text: "done thing", kind: "task", taskStatus: "done" });
  assert.deepEqual(parseNodeDraft("%% [x] faded"), { shouldDelete: false, text: "%% faded", kind: "task", taskStatus: "done" });
  assert.deepEqual(parseNodeDraft("%% faded note"), { shouldDelete: false, text: "%% faded note", kind: "note", taskStatus: null });
  assert.deepEqual(parseNodeDraft("---"), { shouldDelete: false, text: "---", kind: "note", taskStatus: null });
  for (const empty of ["", "   ", "%%", "[ ]", "[x]  "]) assert.deepEqual(parseNodeDraft(empty), { shouldDelete: true });
});

test("parseNodeDraftWithFallback keeps the fallback for plain text", () => {
  assert.deepEqual(parseNodeDraftWithFallback("plain", { kind: "task", taskStatus: "done" }), {
    shouldDelete: false,
    text: "plain",
    kind: "task",
    taskStatus: "done",
  });
  assert.deepEqual(parseNodeDraftWithFallback("plain", { kind: "task", taskStatus: null }), {
    shouldDelete: false,
    text: "plain",
    kind: "task",
    taskStatus: "todo",
  });
  // A separator is always a note.
  assert.equal((parseNodeDraftWithFallback("---", { kind: "task", taskStatus: "todo" }) as { kind: string }).kind, "note");
});
