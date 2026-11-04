import { internal } from "../_generated/api";
import type { ActionCtx, DatabaseReader, DatabaseWriter } from "../_generated/server";
import { assertOwnerKey, isOwnerKeyValid } from "./auth";

// Lockout for failed owner-key attempts.
//
// The correct key ALWAYS works, locked or not, so nobody can lock the owner
// out by sending wrong keys. A lock only changes what a wrong key gets back
// ("Too many failed access attempts" instead of "Invalid owner access token").
//
// Where failures are COUNTED:
// - checkOwnerKey (the app's unlock form) and oauth:approve (the MCP sign-in
//   page): mutations that return the result instead of throwing, so the
//   failure write commits.
// - Actions and HTTP actions: they record the failure in a separate mutation
//   (recordOwnerKeyFailure) before throwing.
// - NOT queries (they can't write) and NOT other mutations (a mutation that
//   throws rolls back every write it made, including the failure count).
//   A guesser can always use those, so the counter is a signal, not a wall.
//   The real protection is a long random OWNER_ACCESS_TOKEN.
const AUTH_THROTTLE_KEY = "owner";
const FREE_FAILURES = 10;
const BASE_LOCK_MS = 60_000;
const MAX_LOCK_MS = 60 * 60_000;
const LOCKED_MESSAGE = "Too many failed access attempts. Try again later.";

export async function getAuthThrottleRow(db: DatabaseReader) {
  return await db
    .query("authThrottle")
    .withIndex("by_key", (query) => query.eq("key", AUTH_THROTTLE_KEY))
    .unique();
}

export async function isAuthLocked(db: DatabaseReader) {
  const row = await getAuthThrottleRow(db);
  return Boolean(row?.lockedUntil && row.lockedUntil > Date.now());
}

// Queries and mutations: the correct key passes; a wrong one throws (with
// the lockout message while locked). Not counted; see above.
export async function assertOwnerKeyGuarded(db: DatabaseReader, ownerKey: string) {
  if (isOwnerKeyValid(ownerKey)) return;
  if (await isAuthLocked(db)) throw new Error(LOCKED_MESSAGE);
  assertOwnerKey(ownerKey);
}

// Actions and HTTP actions: a wrong key is counted, then refused.
export async function assertOwnerKeyGuardedInAction(
  ctx: Pick<ActionCtx, "runMutation">,
  ownerKey: string,
): Promise<void> {
  if (isOwnerKeyValid(ownerKey)) return;
  const { lockedUntil } = await ctx.runMutation(internal.workspace.recordOwnerKeyFailure, {});
  if (lockedUntil && lockedUntil > Date.now()) throw new Error(LOCKED_MESSAGE);
  assertOwnerKey(ownerKey);
}

export async function recordOwnerKeyFailure(db: DatabaseWriter) {
  const now = Date.now();
  const row = await getAuthThrottleRow(db);
  const failedCount = (row?.failedCount ?? 0) + 1;
  const lockedUntil =
    failedCount >= FREE_FAILURES
      ? now + Math.min(BASE_LOCK_MS * 2 ** Math.min(failedCount - FREE_FAILURES, 10), MAX_LOCK_MS)
      : null;
  if (row) {
    await db.patch(row._id, { failedCount, lockedUntil, updatedAt: now });
  } else {
    await db.insert("authThrottle", { key: AUTH_THROTTLE_KEY, failedCount, lockedUntil, updatedAt: now });
  }
  return { lockedUntil };
}

// Non-throwing check for mutations that report the result as a value. The
// correct key succeeds and clears the counter even while locked.
export async function recordOwnerKeyValidation(db: DatabaseWriter, ownerKey: string) {
  if (isOwnerKeyValid(ownerKey)) {
    const row = await getAuthThrottleRow(db);
    if (row && (row.failedCount > 0 || row.lockedUntil !== null)) {
      await db.patch(row._id, { failedCount: 0, lockedUntil: null, updatedAt: Date.now() });
    }
    return { valid: true as const, lockedUntil: null };
  }
  const { lockedUntil } = await recordOwnerKeyFailure(db);
  return { valid: false as const, lockedUntil };
}
