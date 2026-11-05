// Refused writes (enforce mode): reading the error, reporting it, and the
// app's "Not saved" notice. See lib/domain/guardRefusal.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { ConvexError } from "convex/values";
import { guardRefusalMessage, guardRefusalOf, refusalReportArgs, reportGuardRefusal } from "../lib/domain/guardRefusal";
import { createConvexHealthStore, describeWriteError } from "../lib/domain/convexHealth";
import { LEGACY_RECORD_ONLY_MUTATIONS, guardModeFor } from "../convex/lib/guardRules";

const refusalError = () =>
  new ConvexError({
    code: "guardRefused",
    mutation: "workspace:moveNode",
    guard: "assertValidParent",
    message: "That parent is inside the item being moved (it would create a loop).",
    detail: "parent p: loop",
    nodeId: "n1",
    pageId: null,
  });

test("guardRefusalOf reads guardRefused errors only", () => {
  assert.deepEqual(guardRefusalOf(refusalError()), {
    code: "guardRefused",
    mutation: "workspace:moveNode",
    guard: "assertValidParent",
    message: "That parent is inside the item being moved (it would create a loop).",
    detail: "parent p: loop",
    nodeId: "n1",
    pageId: null,
  });
  assert.equal(guardRefusalOf(new ConvexError({ code: "undoRefused", message: "x" })), null);
  assert.equal(guardRefusalOf(new ConvexError("plain")), null);
  assert.equal(guardRefusalOf(new Error("Server Error")), null);
  assert.equal(guardRefusalOf(null), null);
});

test("reportGuardRefusal sends the report and never throws", async () => {
  const sent: object[] = [];
  assert.equal(await reportGuardRefusal(refusalError(), "cli", async (args) => sent.push(args)), true);
  assert.deepEqual(sent, [{ caller: "cli", mutation: "workspace:moveNode", guard: "assertValidParent", detail: "parent p: loop", nodeId: "n1" }]);
  let sentForOther = 0;
  assert.equal(await reportGuardRefusal(new Error("other"), "cli", async () => (sentForOther += 1)), false);
  assert.equal(sentForOther, 0);
  assert.equal(await reportGuardRefusal(refusalError(), "app", async () => { throw new Error("offline"); }), false);
  assert.deepEqual(Object.keys(refusalReportArgs(guardRefusalOf(refusalError())!, "mcp")).sort(), ["caller", "detail", "guard", "mutation", "nodeId"]);
});

test("the app shows a refusal as a dismissable notice, not as an outdated bundle", () => {
  const store = createConvexHealthStore();
  assert.equal(store.reportGuardRefusal(new Error("other")), false);
  assert.equal(store.reportGuardRefusal(refusalError(), 10), true);
  const snapshot = store.getSnapshot();
  assert.equal(snapshot.problem, null);
  assert.equal(snapshot.lastFailedWriteAt, null);
  assert.deepEqual(snapshot.refusal, { message: guardRefusalMessage(guardRefusalOf(refusalError())!), at: 10 });
  assert.equal(store.reportWriteError(refusalError()), false);
  store.clearRefusal(5);
  assert.notEqual(store.getSnapshot().refusal, null);
  store.clearRefusal(10);
  assert.equal(store.getSnapshot().refusal, null);
  assert.equal(describeWriteError(refusalError(), "fallback"), "Not saved: That parent is inside the item being moved (it would create a loop).");
});

test("legacy record-only mutations stay in record mode under enforce", () => {
  assert.equal(guardModeFor("workspace:deleteNode", "enforce"), "record");
  assert.equal(guardModeFor("workspace:updateNode", "enforce"), "enforce");
  assert.equal(guardModeFor("workspace:updateNode", "record"), "record");
  assert.ok(LEGACY_RECORD_ONLY_MUTATIONS.size > 0);
});
