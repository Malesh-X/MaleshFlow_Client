// One shared "out of date / connection problem" state for the app.
//
// Workspace queries never throw into React (see components/useWorkspaceQuery.ts):
// a failing subscription keeps its last good value and reports here instead.
// Mutations and actions that fail because the backend no longer matches this
// bundle report here too. The app shows a small banner from this state and
// the stale-tab watcher reloads at a safe moment (components/appUpdate.tsx).
// A write the server guards refused is not an outdated bundle: it shows a short
// "Not saved" notice in the same banner and needs no reload.

import { guardRefusalMessage, guardRefusalOf } from "./guardRefusal";

export type ConvexProblemKind =
  // The backend no longer has (or no longer accepts) what this bundle calls:
  // a deploy changed it. Reloading fixes it once the new frontend is live.
  | "outdated"
  // Any other server error from a query.
  | "server";

export type ConvexProblem = {
  kind: ConvexProblemKind;
  source: string;
  message: string;
};

export type ConvexHealthSnapshot = {
  // The worst open problem, or null when every subscription is healthy.
  problem: ConvexProblem | null;
  // When a write last failed because this bundle is out of date.
  lastFailedWriteAt: number | null;
  // The last write the server guards refused, until it is dismissed.
  refusal: { message: string; at: number } | null;
};

function errorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

// Errors the server returns when the deployed functions no longer match the
// bundle that called them: a removed function, or changed arguments.
export function isOutdatedClientError(error: unknown) {
  const message = errorMessage(error);
  return (
    /Could not find public function/i.test(message) ||
    /ArgumentValidationError/.test(message) ||
    /Object contains extra field/i.test(message) ||
    /Object is missing the required field/i.test(message)
  );
}

export function classifyConvexError(error: unknown): ConvexProblemKind {
  return isOutdatedClientError(error) ? "outdated" : "server";
}

export function createConvexHealthStore() {
  const queryProblems = new Map<string, ConvexProblem>();
  const listeners = new Set<() => void>();
  let lastFailedWriteAt: number | null = null;
  let refusal: ConvexHealthSnapshot["refusal"] = null;
  let snapshot: ConvexHealthSnapshot = { problem: null, lastFailedWriteAt: null, refusal: null };

  const recompute = () => {
    let problem: ConvexProblem | null = null;
    for (const entry of queryProblems.values()) {
      if (!problem || (problem.kind !== "outdated" && entry.kind === "outdated")) {
        problem = entry;
      }
    }
    if (!problem && lastFailedWriteAt !== null) {
      problem = { kind: "outdated", source: "write", message: "" };
    }
    if (problem !== snapshot.problem || lastFailedWriteAt !== snapshot.lastFailedWriteAt || refusal !== snapshot.refusal) {
      snapshot = { problem, lastFailedWriteAt, refusal };
      for (const listener of listeners) {
        listener();
      }
    }
  };

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    // A query subscription (by a stable id per hook) failed.
    reportQueryError(id: string, source: string, error: unknown) {
      const message = errorMessage(error);
      const existing = queryProblems.get(id);
      if (existing && existing.message === message && existing.source === source) {
        return;
      }
      queryProblems.set(id, { kind: classifyConvexError(error), source, message });
      recompute();
    },
    // The subscription recovered, was skipped or unmounted.
    clearQueryError(id: string) {
      if (queryProblems.delete(id)) {
        recompute();
      }
    },
    // A mutation or action failed. Only an out-of-date bundle counts: other
    // failures (a refusal, a conflict) are the caller's to show.
    reportWriteError(error: unknown, now = Date.now()) {
      if (!isOutdatedClientError(error)) {
        return false;
      }
      lastFailedWriteAt = now;
      recompute();
      return true;
    },
    // A write the server guards refused. Returns true when the error was one.
    reportGuardRefusal(error: unknown, now = Date.now()) {
      const found = guardRefusalOf(error);
      if (!found) {
        return false;
      }
      refusal = { message: guardRefusalMessage(found), at: now };
      recompute();
      return true;
    },
    // Hides the refusal notice (only the one shown at `at`, when given).
    clearRefusal(at?: number) {
      if (!refusal || (at !== undefined && refusal.at !== at)) {
        return;
      }
      refusal = null;
      recompute();
    },
    reset() {
      queryProblems.clear();
      lastFailedWriteAt = null;
      refusal = null;
      recompute();
    },
  };
}

export type ConvexHealthStore = ReturnType<typeof createConvexHealthStore>;

export const convexHealth = createConvexHealthStore();

// The message the app shows where a write from an out-of-date tab failed.
export const OUTDATED_WRITE_MESSAGE =
  "Flow was updated, so this change didn't save. Your text is still here. Reload to keep working.";

export function describeWriteError(error: unknown, fallbackMessage: string) {
  if (isOutdatedClientError(error)) {
    return OUTDATED_WRITE_MESSAGE;
  }
  const refusal = guardRefusalOf(error);
  if (refusal) {
    return guardRefusalMessage(refusal);
  }
  const message = errorMessage(error).trim();
  return message.length > 0 ? message : fallbackMessage;
}
