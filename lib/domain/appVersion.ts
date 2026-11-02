// Stale-tab detection and recovery rules.
//
// Each build bakes its identity into the client (NEXT_PUBLIC_BUILD_ID). The
// /api/version endpoint returns the identity of the frontend that is deployed
// now. A tab whose identity differs is running an old bundle: a deploy may
// have removed or changed Convex functions it still calls, so it should
// reload, but only at a moment when nothing unsaved would be lost.

export type BuildStatus = "current" | "stale" | "unknown";

export function compareBuildIds(
  clientBuildId: string | null | undefined,
  deployedBuildId: string | null | undefined,
): BuildStatus {
  const client = clientBuildId?.trim() ?? "";
  const deployed = deployedBuildId?.trim() ?? "";
  if (!client || !deployed) {
    return "unknown";
  }
  return client === deployed ? "current" : "stale";
}

export type ReloadSafetyInput = {
  inflightMutations: number;
  inflightActions: number;
  hasUnsavedEdits: boolean;
};

// Safe means a reload loses nothing: no mutation or action still waiting on
// the server, and no editor holding text that has not been saved.
export function isSafeToReload(input: ReloadSafetyInput) {
  return (
    input.inflightMutations === 0 &&
    input.inflightActions === 0 &&
    !input.hasUnsavedEdits
  );
}

export const AUTO_RELOAD_MIN_INTERVAL_MS = 60_000;
export const STALE_NOTICE_AFTER_MS = 2 * 60_000;

// At most one automatic reload per interval, so a deploy that keeps serving an
// old bundle (or an error that survives a reload) can never loop.
export function canAutoReload(
  lastAutoReloadAt: number | null,
  now: number,
  minIntervalMs = AUTO_RELOAD_MIN_INTERVAL_MS,
) {
  if (lastAutoReloadAt === null || !Number.isFinite(lastAutoReloadAt)) {
    return true;
  }
  // A timestamp in the future (clock change) does not block forever.
  if (lastAutoReloadAt > now) {
    return true;
  }
  return now - lastAutoReloadAt >= minIntervalMs;
}

export function parseLastAutoReloadAt(stored: string | null): number | null {
  if (!stored) {
    return null;
  }
  const value = Number(stored);
  return Number.isFinite(value) ? value : null;
}

export type StaleTabAction = "reload" | "notify" | "wait";

export type StaleTabInput = {
  safe: boolean;
  // The tab is hidden or the window does not have focus.
  away: boolean;
  // This check ran because the person just came back to the tab.
  returning: boolean;
  staleForMs: number;
  reloadAllowed: boolean;
  noticeAfterMs?: number;
};

// What a stale tab does now. It reloads while the person is away or the
// moment they come back, never while they are working in it; if that moment
// does not come soon, it shows a small notice instead of interrupting.
export function decideStaleTabAction(input: StaleTabInput): StaleTabAction {
  const noticeAfterMs = input.noticeAfterMs ?? STALE_NOTICE_AFTER_MS;
  if (input.reloadAllowed && input.safe && (input.away || input.returning)) {
    return "reload";
  }
  if (!input.reloadAllowed || input.staleForMs >= noticeAfterMs) {
    return "notify";
  }
  return "wait";
}

// Errors thrown by a Convex query or mutation from the server, for example
// "[CONVEX Q(chatData:getX)] [Request ID: …] Server Error Could not find
// public function for 'chatData:getX'".
export function isConvexServerError(error: unknown) {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "";
  return /\[CONVEX [QMA]\(/.test(message) || /Could not find public function/.test(message);
}

export type ErrorRecoveryAction = "reload" | "show";

// When the workspace crashes on a Convex server error, an old bundle is the
// likely cause: reload once if the tab is stale or the version cannot be
// checked. A current build keeps the error screen so real bugs still surface.
export function decideErrorRecovery(input: {
  isConvexError: boolean;
  buildStatus: BuildStatus;
  reloadAllowed: boolean;
}): ErrorRecoveryAction {
  if (!input.isConvexError || !input.reloadAllowed) {
    return "show";
  }
  return input.buildStatus === "current" ? "show" : "reload";
}
