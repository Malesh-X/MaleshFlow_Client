"use client";

// Keeps open tabs on the deployed frontend. A tab still running an old bundle
// after a deploy can call Convex functions that no longer exist; this finds
// such tabs and reloads them at a safe moment (see lib/domain/appVersion.ts).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { ConvexReactClient } from "convex/react";
import {
  canAutoReload,
  compareBuildIds,
  decideErrorRecovery,
  decideStaleTabAction,
  isConvexServerError,
  isSafeToReload,
  parseLastAutoReloadAt,
  type BuildStatus,
} from "@/lib/domain/appVersion";
import { convexHealth, type ConvexHealthSnapshot } from "@/lib/domain/convexHealth";

export const CLIENT_BUILD_ID = process.env.NEXT_PUBLIC_BUILD_ID ?? null;

const VERSION_ENDPOINT = "/api/version";
const VERSION_FETCH_TIMEOUT_MS = 5_000;
const VERSION_CHECK_THROTTLE_MS = 10_000;
const VERSION_POLL_INTERVAL_MS = 5 * 60_000;
const STALE_TICK_INTERVAL_MS = 15_000;
// While a Convex call is failing, look for the new frontend this often: during
// a deploy the backend changes first and the new frontend goes live a few
// minutes later.
const PROBLEM_POLL_INTERVAL_MS = 15_000;
const LAST_AUTO_RELOAD_KEY = "flow:lastAutoReloadAt";

// Pending local edits the reload must not drop. Editors register a probe
// that reports whether they hold text not yet saved.
const unsavedEditsProbes = new Set<() => boolean>();

export function registerUnsavedEditsProbe(probe: () => boolean) {
  unsavedEditsProbes.add(probe);
  return () => {
    unsavedEditsProbes.delete(probe);
  };
}

export function hasUnsavedEdits() {
  for (const probe of unsavedEditsProbes) {
    try {
      if (probe()) {
        return true;
      }
    } catch {
      return true;
    }
  }
  return false;
}

export async function fetchDeployedBuildId(): Promise<string | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), VERSION_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(VERSION_ENDPOINT, {
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const body = (await response.json()) as { buildId?: unknown };
    return typeof body.buildId === "string" ? body.buildId : null;
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}

export async function checkBuildStatus(): Promise<BuildStatus> {
  return compareBuildIds(CLIENT_BUILD_ID, await fetchDeployedBuildId());
}

function readLastAutoReloadAt() {
  try {
    return parseLastAutoReloadAt(window.sessionStorage.getItem(LAST_AUTO_RELOAD_KEY));
  } catch {
    return null;
  }
}

function isAutoReloadAllowed() {
  return canAutoReload(readLastAutoReloadAt(), Date.now());
}

// Reloads in place (same URL, so the same page and focus reopen) and records
// it, so the loop guard can refuse the next one for a while.
function autoReload() {
  try {
    window.sessionStorage.setItem(LAST_AUTO_RELOAD_KEY, String(Date.now()));
  } catch {
    // Without sessionStorage the guard cannot hold, so do not auto-reload.
    return false;
  }
  window.location.reload();
  return true;
}

// The Reload buttons. Asks first when an editor holds text that has not saved.
export function reloadNow() {
  if (
    hasUnsavedEdits() &&
    !window.confirm("Some text hasn't saved yet. Reload anyway and lose it?")
  ) {
    return;
  }
  window.location.reload();
}

const SERVER_HEALTH: ConvexHealthSnapshot = { problem: null, lastFailedWriteAt: null, refusal: null };
// How long a "Not saved" notice for a refused write stays up.
const REFUSAL_NOTICE_MS = 6_000;
const getServerHealth = () => SERVER_HEALTH;

export function useConvexHealth() {
  return useSyncExternalStore(convexHealth.subscribe, convexHealth.getSnapshot, getServerHealth);
}

// Called by the workspace error boundary. Returns true when it reloaded.
export async function recoverFromConvexError(error: unknown) {
  const isConvexError = isConvexServerError(error);
  if (!isConvexError || !isAutoReloadAllowed()) {
    return false;
  }
  const action = decideErrorRecovery({
    isConvexError,
    buildStatus: await checkBuildStatus(),
    reloadAllowed: isAutoReloadAllowed(),
  });
  return action === "reload" ? autoReload() : false;
}

export function StaleTabWatcher({ client }: { client: ConvexReactClient | null }) {
  const [showNotice, setShowNotice] = useState(false);
  const health = useConvexHealth();
  const hasProblem = health.problem !== null;
  const hasProblemRef = useRef(hasProblem);
  const staleSinceRef = useRef<number | null>(null);
  const lastCheckAtRef = useRef(0);
  const checkingRef = useRef(false);

  useEffect(() => {
    hasProblemRef.current = hasProblem;
  }, [hasProblem]);

  const evaluate = useCallback(
    (returning: boolean) => {
      const staleSince = staleSinceRef.current;
      if (staleSince === null) {
        return;
      }
      const connection = client?.connectionState();
      const action = decideStaleTabAction({
        safe: isSafeToReload({
          inflightMutations: connection?.inflightMutations ?? 0,
          inflightActions: connection?.inflightActions ?? 0,
          hasUnsavedEdits: hasUnsavedEdits(),
        }),
        away: document.visibilityState === "hidden" || !document.hasFocus(),
        returning,
        staleForMs: Date.now() - staleSince,
        reloadAllowed: isAutoReloadAllowed(),
        hasConvexProblem: hasProblemRef.current,
      });
      if (action === "reload" && autoReload()) {
        return;
      }
      if (action !== "wait") {
        setShowNotice(true);
      }
    },
    [client],
  );

  const check = useCallback(
    async (returning: boolean) => {
      if (staleSinceRef.current !== null) {
        evaluate(returning);
        return;
      }
      const now = Date.now();
      if (checkingRef.current || now - lastCheckAtRef.current < VERSION_CHECK_THROTTLE_MS) {
        return;
      }
      checkingRef.current = true;
      lastCheckAtRef.current = now;
      try {
        if ((await checkBuildStatus()) === "stale") {
          staleSinceRef.current = Date.now();
          evaluate(returning);
        }
      } finally {
        checkingRef.current = false;
      }
    },
    [evaluate],
  );

  useEffect(() => {
    const onFocus = () => void check(true);
    const onVisibilityChange = () => {
      void check(document.visibilityState === "visible");
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibilityChange);
    const poll = window.setInterval(() => void check(false), VERSION_POLL_INTERVAL_MS);
    const tick = window.setInterval(() => {
      if (staleSinceRef.current !== null) {
        evaluate(false);
      }
    }, STALE_TICK_INTERVAL_MS);

    let lastConnectionCount = client?.connectionState().connectionCount ?? 0;
    const unsubscribe = client?.subscribeToConnectionState((state) => {
      if (state.connectionCount > lastConnectionCount) {
        const isReconnect = lastConnectionCount > 0;
        lastConnectionCount = state.connectionCount;
        if (isReconnect) {
          void check(false);
        }
      }
    });

    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.clearInterval(poll);
      window.clearInterval(tick);
      unsubscribe?.();
    };
  }, [check, client, evaluate]);

  // A failing Convex call: check for the new frontend now, then keep checking
  // until it is live (reloading when safe) or the problem clears.
  useEffect(() => {
    if (!hasProblem) {
      return;
    }
    void check(false);
    const poll = window.setInterval(() => void check(false), PROBLEM_POLL_INTERVAL_MS);
    return () => window.clearInterval(poll);
  }, [check, hasProblem]);

  const refusalAt = health.refusal?.at ?? null;
  useEffect(() => {
    if (refusalAt === null) {
      return;
    }
    const timeout = window.setTimeout(() => convexHealth.clearRefusal(refusalAt), REFUSAL_NOTICE_MS);
    return () => window.clearTimeout(timeout);
  }, [refusalAt]);

  return <AppStatusBanner health={health} stale={showNotice} />;
}

// Small, non-blocking notice at the bottom right. The workspace keeps working
// (with its last loaded data) underneath.
export function AppStatusBanner({
  health,
  stale,
}: {
  health: ConvexHealthSnapshot;
  stale: boolean;
}) {
  if (!health.problem && !stale) {
    // A refused write: the change was checked and turned down, so there is
    // nothing to reload. The editor keeps its text.
    if (health.refusal) {
      return (
        <div
          role="status"
          className="fixed bottom-4 right-4 z-[1000] max-w-[calc(100vw-2rem)] border border-[var(--workspace-danger)]/60 bg-[var(--workspace-surface)] px-3 py-2 text-sm text-[var(--workspace-text)] shadow-lg"
        >
          {health.refusal.message}
        </div>
      );
    }
    return null;
  }
  const message =
    health.problem?.kind === "server" && !stale
      ? "Flow can't load the latest data."
      : "Flow was updated.";

  return (
    <div
      role="status"
      className="fixed bottom-4 right-4 z-[1000] flex max-w-[calc(100vw-2rem)] flex-col gap-1 border border-[var(--workspace-border)] bg-[var(--workspace-surface)] px-3 py-2 text-sm text-[var(--workspace-text)] shadow-lg"
    >
      <div className="flex items-center gap-3">
        <span>{message}</span>
        <button
          type="button"
          onClick={reloadNow}
          className="font-semibold text-[var(--workspace-brand)] hover:underline"
        >
          Reload
        </button>
      </div>
      {health.lastFailedWriteAt !== null ? (
        <span className="text-xs text-[var(--workspace-text-subtle)]">
          A change didn&apos;t save. Your text is still here.
        </span>
      ) : null}
    </div>
  );
}
