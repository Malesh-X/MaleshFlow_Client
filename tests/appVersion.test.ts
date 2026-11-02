import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_RELOAD_MIN_INTERVAL_MS,
  STALE_NOTICE_AFTER_MS,
  canAutoReload,
  compareBuildIds,
  decideErrorRecovery,
  decideStaleTabAction,
  isConvexServerError,
  isSafeToReload,
  parseLastAutoReloadAt,
} from "../lib/domain/appVersion";

test("a tab is stale only when both build ids are known and differ", () => {
  assert.equal(compareBuildIds("abc", "abc"), "current");
  assert.equal(compareBuildIds("abc", "def"), "stale");
  assert.equal(compareBuildIds("abc", null), "unknown");
  assert.equal(compareBuildIds(null, "def"), "unknown");
  assert.equal(compareBuildIds("abc", "  "), "unknown");
});

test("a reload is safe only with no in-flight writes and no unsaved edits", () => {
  const idle = { inflightMutations: 0, inflightActions: 0, hasUnsavedEdits: false };
  assert.equal(isSafeToReload(idle), true);
  assert.equal(isSafeToReload({ ...idle, inflightMutations: 1 }), false);
  assert.equal(isSafeToReload({ ...idle, inflightActions: 2 }), false);
  assert.equal(isSafeToReload({ ...idle, hasUnsavedEdits: true }), false);
});

test("a stale tab reloads while away or on return, only when safe", () => {
  const base = {
    safe: true,
    away: false,
    returning: false,
    staleForMs: 0,
    reloadAllowed: true,
  };
  assert.equal(decideStaleTabAction({ ...base, away: true }), "reload");
  assert.equal(decideStaleTabAction({ ...base, returning: true }), "reload");
  // In use: wait rather than interrupt.
  assert.equal(decideStaleTabAction(base), "wait");
  // Unsaved work: never reload, even while away.
  assert.equal(decideStaleTabAction({ ...base, safe: false, away: true }), "wait");
});

test("a stale tab that never reaches a safe moment shows a notice", () => {
  const base = {
    safe: false,
    away: false,
    returning: false,
    staleForMs: STALE_NOTICE_AFTER_MS,
    reloadAllowed: true,
  };
  assert.equal(decideStaleTabAction(base), "notify");
  assert.equal(decideStaleTabAction({ ...base, away: true }), "notify");
  // A safe moment later still reloads.
  assert.equal(decideStaleTabAction({ ...base, safe: true, away: true }), "reload");
});

test("a stale tab whose auto-reload is refused by the loop guard shows a notice", () => {
  assert.equal(
    decideStaleTabAction({
      safe: true,
      away: true,
      returning: false,
      staleForMs: 0,
      reloadAllowed: false,
    }),
    "notify",
  );
});

test("the loop guard allows one auto-reload per interval", () => {
  const now = 1_000_000;
  assert.equal(canAutoReload(null, now), true);
  assert.equal(canAutoReload(now - 1_000, now), false);
  assert.equal(canAutoReload(now - AUTO_RELOAD_MIN_INTERVAL_MS + 1, now), false);
  assert.equal(canAutoReload(now - AUTO_RELOAD_MIN_INTERVAL_MS, now), true);
  // A future timestamp (clock change) does not block forever.
  assert.equal(canAutoReload(now + 60_000, now), true);
  assert.equal(parseLastAutoReloadAt(null), null);
  assert.equal(parseLastAutoReloadAt("garbage"), null);
  assert.equal(parseLastAutoReloadAt("123"), 123);
});

test("Convex server errors are recognised", () => {
  assert.equal(
    isConvexServerError(
      new Error(
        "[CONVEX Q(chatData:getWorkspaceKnowledgeThread)] [Request ID: abc] Server Error\nCould not find public function for 'chatData:getWorkspaceKnowledgeThread'",
      ),
    ),
    true,
  );
  assert.equal(isConvexServerError(new Error("[CONVEX M(nodes:update)] Server Error")), true);
  assert.equal(isConvexServerError(new Error("Cannot read properties of undefined")), false);
  assert.equal(isConvexServerError(null), false);
});

test("a Convex crash reloads once unless the build is current", () => {
  const base = { isConvexError: true, reloadAllowed: true };
  assert.equal(decideErrorRecovery({ ...base, buildStatus: "stale" }), "reload");
  assert.equal(decideErrorRecovery({ ...base, buildStatus: "unknown" }), "reload");
  assert.equal(decideErrorRecovery({ ...base, buildStatus: "current" }), "show");
  assert.equal(
    decideErrorRecovery({ ...base, buildStatus: "stale", reloadAllowed: false }),
    "show",
  );
  assert.equal(
    decideErrorRecovery({ isConvexError: false, buildStatus: "stale", reloadAllowed: true }),
    "show",
  );
});
