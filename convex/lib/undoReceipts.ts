// Stored, conflict-checked undo receipts for completions (Phase 4 of
// docs/server-logic-plan.md).
//
// A completion returns a receipt id. The stored receipt holds:
// - what the completion changed (PlannerCompletionReceipt: before-states of
//   patched items, the nodes it created, the subtree it archived, the sidebar
//   favorites it removed), which undo uses to put things back;
// - `expect`: the revision every touched item is at after the action;
// - `subtrees`: the members of every subtree undo would delete (Past Weeks or
//   Done copies, appended planner copies) or restore (the archived original).
//
// Undo refuses, naming what changed, when any item's revision differs or any
// of those subtrees gained or lost an item. The membership check matters:
// adding a child doesn't change its parent's revision, so revisions alone
// would let undo delete a child added after the completion.
//
// Chains: undoing receipt B puts items back the way receipt A left them. If
// A's expected revisions equal B's starting revisions (nothing happened in
// between), undoing B rewrites A's expectations to the revisions it just
// wrote, so undoing A next still passes. Redo does the same in reverse. Any
// other edit in between breaks the chain, and that undo refuses.
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import type { PlannerCompletionReceipt } from "../../lib/domain/planner";
import type { RecurringCompletionMode } from "../../lib/domain/recurrence";
import { trackNodeWrites } from "./guards";
import { getNodeSourceMeta } from "./planner";
import {
  collectNodeTree,
  deleteNodeTree,
  enqueueNodeAiWork,
  enqueuePageRootEmbeddingRefresh,
  setNodeTreeArchivedState,
  syncLinksForNode,
} from "./workspace";

export type ReceiptAction = {
  action: "completion" | "forceArchive";
  targetNodeId: Id<"nodes">;
  completionMode: RecurringCompletionMode;
  plannerPageId?: Id<"pages">;
  intent?: "complete" | "reopen";
};

type ReceiptRow = Doc<"undoReceipts">;
type Expectation = ReceiptRow["expect"][number];
type Subtree = ReceiptRow["subtrees"][number];

const RECEIPT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_PER_WRITE = 5;
// How many recent receipts a chain rewrite looks at. A receipt older than this
// that should have been rewritten just refuses later, which is safe.
const CHAIN_SCAN_LIMIT = 100;
const MAX_REASONS_SHOWN = 3;

// Refusals are ConvexErrors with this code, so clients can tell "refused,
// nothing changed" apart from a failed request.
export const UNDO_REFUSED = "undoRefused";
function refuse(message: string): never {
  throw new ConvexError({ code: UNDO_REFUSED, message });
}

const label = (text: string | undefined) => {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  if (!clean) return "an untitled item";
  return `"${clean.length > 40 ? `${clean.slice(0, 39)}…` : clean}"`;
};

function refusalMessage(verb: "undo" | "redo", reasons: string[]) {
  const shown = reasons.slice(0, MAX_REASONS_SHOWN).join("; ");
  const more = reasons.length > MAX_REASONS_SHOWN ? ` (and ${reasons.length - MAX_REASONS_SHOWN} more)` : "";
  return `Can't ${verb} this completion: ${shown}${more}. Nothing was ${verb === "undo" ? "undone" : "redone"}.`;
}

// ---- capturing an action ----

function normalizeNodeId(ctx: MutationCtx, raw: string | null | undefined) {
  return raw ? ctx.db.normalizeId("nodes", raw) : null;
}

async function receiptSubtrees(ctx: MutationCtx, receipt: PlannerCompletionReceipt) {
  const roots: [Subtree["role"], string | null][] = [
    ["delete", receipt.pastWeeksCloneRootNodeId],
    ...receipt.appendedPlannerNodeIds.map((id): [Subtree["role"], string] => ["delete", id]),
    ["restore", receipt.archivedRootNodeId],
  ];
  const subtrees: Subtree[] = [];
  for (const [role, raw] of roots) {
    const rootNodeId = normalizeNodeId(ctx, raw);
    if (!rootNodeId) continue;
    const nodes = await collectNodeTree(ctx.db, rootNodeId);
    if (nodes.length) subtrees.push({ role, rootNodeId, nodeIds: nodes.map((node) => node._id) });
  }
  return subtrees;
}

async function currentExpectations(ctx: MutationCtx, nodeIds: Iterable<Id<"nodes">>) {
  const expect: Expectation[] = [];
  for (const nodeId of new Set(nodeIds)) {
    const node = await ctx.db.get(nodeId);
    if (node) expect.push({ nodeId, revision: node.revision ?? 0, text: node.text.slice(0, 80) });
  }
  return expect;
}

// What a completion (or redo) just did, checked by the next undo: revisions
// after the action, revisions before it, and the subtrees undo would touch.
async function captureApplied(ctx: MutationCtx, receipt: PlannerCompletionReceipt, writes: ReadonlyMap<string, number | null>) {
  const subtrees = await receiptSubtrees(ctx, receipt);
  const touched = [
    ...receipt.plannerNodes.map((entry) => normalizeNodeId(ctx, entry.nodeId)),
    ...receipt.sourceTasks.map((entry) => normalizeNodeId(ctx, entry.nodeId)),
    ...subtrees.flatMap((subtree) => subtree.nodeIds),
  ].filter((id): id is Id<"nodes"> => id !== null);
  const expect = await currentExpectations(ctx, touched);
  // Items the action created have no "before"; items it didn't write keep
  // their current revision.
  const prev = expect
    .filter((entry) => writes.get(entry.nodeId) !== null)
    .map((entry) => ({ nodeId: entry.nodeId, revision: writes.get(entry.nodeId) ?? entry.revision }));
  return { expect, prev, subtrees };
}

// Runs a completion and stores its receipt. `run` returns the completion's
// receipt, or null when it changed nothing (no receipt is stored then).
export async function runWithReceipt<T extends { receipt: PlannerCompletionReceipt | null }>(
  ctx: MutationCtx,
  action: ReceiptAction,
  run: () => Promise<T>,
): Promise<T & { receiptId: Id<"undoReceipts"> | null }> {
  const tracker = trackNodeWrites(ctx);
  let result: T;
  try {
    result = await run();
  } finally {
    tracker.stop();
  }
  if (!result.receipt) return { ...result, receiptId: null };
  const captured = await captureApplied(ctx, result.receipt, tracker.writes);
  const now = Date.now();
  const receiptId = await ctx.db.insert("undoReceipts", {
    ...action,
    state: "applied",
    receipt: result.receipt,
    ...captured,
    createdAt: now,
    updatedAt: now,
  });
  await pruneOldReceipts(ctx, now);
  return { ...result, receiptId };
}

async function pruneOldReceipts(ctx: MutationCtx, now: number) {
  const old = await ctx.db
    .query("undoReceipts")
    .withIndex("by_creation_time", (query) => query.lt("_creationTime", now - RECEIPT_TTL_MS))
    .take(PRUNE_PER_WRITE);
  for (const row of old) await ctx.db.delete(row._id);
}

// ---- checks ----

async function receiptProblems(ctx: MutationCtx, row: ReceiptRow, options: { membership: boolean }) {
  const reasons: string[] = [];
  for (const entry of row.expect) {
    const node = await ctx.db.get(entry.nodeId);
    if (!node) reasons.push(`${label(entry.text)} was deleted`);
    else if ((node.revision ?? 0) !== entry.revision) reasons.push(`${label(node.text)} was changed`);
  }
  if (!options.membership) return reasons;
  for (const subtree of row.subtrees) {
    const current = await collectNodeTree(ctx.db, subtree.rootNodeId);
    if (!current.length) continue; // reported above: the root is in `expect`
    const recorded = new Set<string>(subtree.nodeIds);
    const byId = new Map(current.map((node) => [node._id as string, node]));
    for (const node of current) {
      if (recorded.has(node._id)) continue;
      const parent = node.parentNodeId ? byId.get(node.parentNodeId) : null;
      reasons.push(`${label(node.text)} was added under ${label(parent?.text)}`);
    }
    const missing = subtree.nodeIds.filter((id) => !byId.has(id)).length;
    if (missing) {
      const root = byId.get(subtree.rootNodeId);
      reasons.push(`${missing === 1 ? "an item was" : `${missing} items were`} moved out of ${label(root?.text)}`);
    }
  }
  return [...new Set(reasons)];
}

// ---- restoring ----

// Reverses a completion from its receipt: deletes the nodes the completion
// created (Past Weeks or Done copies, recurring planner copies), unarchives
// the original subtree, restores patched items and source tasks, and puts
// removed sidebar favorites back. Nodes that no longer exist are skipped.
// The checked undo verifies the receipt first; the legacy adapter doesn't.
export async function restoreCompletionReceipt(ctx: MutationCtx, receipt: PlannerCompletionReceipt) {
  const now = Date.now();
  const touchedPageIds = new Set<string>();

  const createdNodeIds = [
    ...(receipt.pastWeeksCloneRootNodeId ? [receipt.pastWeeksCloneRootNodeId] : []),
    ...receipt.appendedPlannerNodeIds,
  ];
  for (const rawNodeId of createdNodeIds) {
    const nodeId = normalizeNodeId(ctx, rawNodeId);
    const node = nodeId ? await ctx.db.get(nodeId) : null;
    if (!nodeId || !node) continue;
    touchedPageIds.add(node.pageId as string);
    await deleteNodeTree(ctx.db, nodeId);
  }

  const rootNodeId = normalizeNodeId(ctx, receipt.archivedRootNodeId);
  const rootNode = rootNodeId ? await ctx.db.get(rootNodeId) : null;
  if (rootNodeId && rootNode) {
    const descendants = await setNodeTreeArchivedState(ctx.db, rootNodeId, false, now);
    for (const descendant of descendants) {
      await syncLinksForNode(ctx.db, { ...descendant, archived: false });
      await enqueueNodeAiWork(ctx, descendant._id);
    }
    touchedPageIds.add(rootNode.pageId as string);
  }

  for (const entry of receipt.plannerNodes) {
    const nodeId = normalizeNodeId(ctx, entry.nodeId);
    const node = nodeId ? await ctx.db.get(nodeId) : null;
    if (!nodeId || !node) continue;
    await ctx.db.patch(nodeId, {
      taskStatus: entry.taskStatus,
      dueAt: entry.dueAt,
      dueEndAt: entry.dueEndAt,
      sourceMeta: entry.sourceMeta === null ? undefined : entry.sourceMeta,
      updatedAt: now,
    });
    touchedPageIds.add(node.pageId as string);
  }

  for (const entry of receipt.sourceTasks) {
    const nodeId = normalizeNodeId(ctx, entry.nodeId);
    const node = nodeId ? await ctx.db.get(nodeId) : null;
    if (!nodeId || !node) continue;
    await ctx.db.patch(nodeId, {
      taskStatus: entry.taskStatus,
      dueAt: entry.dueAt,
      dueEndAt: entry.dueEndAt,
      ...(typeof entry.occurrenceIndex === "number"
        ? { sourceMeta: { ...getNodeSourceMeta(node), occurrenceIndex: entry.occurrenceIndex } }
        : {}),
      updatedAt: now,
    });
    touchedPageIds.add(node.pageId as string);
  }

  for (const favorite of receipt.deletedFavorites) {
    const targetPageId = ctx.db.normalizeId("pages", favorite.targetPageId);
    const targetNodeId = favorite.targetNodeId ? normalizeNodeId(ctx, favorite.targetNodeId) : null;
    if (!targetPageId || (favorite.targetNodeId && !targetNodeId)) continue;
    const existing = await ctx.db
      .query("sidebarFavorites")
      .withIndex("by_target", (query) =>
        query.eq("targetKind", favorite.targetKind).eq("targetPageId", targetPageId).eq("targetNodeId", targetNodeId),
      )
      .first();
    if (existing) continue;
    await ctx.db.insert("sidebarFavorites", {
      targetKind: favorite.targetKind,
      targetPageId,
      targetNodeId,
      position: favorite.position,
      createdAt: now,
      updatedAt: now,
    });
  }

  for (const pageId of touchedPageIds) {
    await enqueuePageRootEmbeddingRefresh(ctx, pageId as Id<"pages">);
  }
}

// ---- chains ----

// After `row` moves from one state to the other, receipts in `otherState`
// that expected exactly the revisions `row` started from (row.prev) now
// expect the revisions it just wrote (`end`).
async function rewriteChain(ctx: MutationCtx, row: ReceiptRow, otherState: ReceiptRow["state"], end: Map<string, number>) {
  const prev = new Map<string, number>(row.prev.map((entry) => [entry.nodeId, entry.revision]));
  if (!prev.size) return;
  const candidates = await ctx.db
    .query("undoReceipts")
    .withIndex("by_state_and_updatedAt", (query) => query.eq("state", otherState))
    .order("desc")
    .take(CHAIN_SCAN_LIMIT);
  for (const other of candidates) {
    if (other._id === row._id) continue;
    const overlap = other.expect.filter((entry) => prev.has(entry.nodeId));
    if (!overlap.length || overlap.some((entry) => prev.get(entry.nodeId) !== entry.revision)) continue;
    await ctx.db.patch(other._id, {
      expect: other.expect.map((entry) => {
        const next = prev.has(entry.nodeId) ? end.get(entry.nodeId) : undefined;
        return next === undefined ? entry : { ...entry, revision: next };
      }),
    });
  }
}

// ---- undo and redo ----

async function loadReceipt(ctx: MutationCtx, rawId: string) {
  const id = ctx.db.normalizeId("undoReceipts", rawId);
  const row = id ? await ctx.db.get(id) : null;
  if (!row) refuse("That undo step is no longer available (receipts are kept for 30 days).");
  return row;
}

// A text edit undone or redone in the same step as a completion (the app's
// "edit the text, then check the box"). The item must be one the receipt
// checks, so the receipt's check covers it before anything is written.
export type CompanionEdit = { nodeId: Id<"nodes">; apply: () => Promise<unknown> };

function assertCoversEdit(row: ReceiptRow, edit: CompanionEdit | undefined, verb: "undo" | "redo") {
  if (edit && !row.expect.some((entry) => entry.nodeId === edit.nodeId)) {
    refuse(`Can't ${verb} this step: the text edit isn't part of that completion. Nothing was ${verb === "undo" ? "undone" : "redone"}.`);
  }
}

// Checked undo of one stored receipt. Throws an undoRefused ConvexError, with
// nothing changed, when the items moved on since the completion. `edit` is
// undone right after the completion, in the same transaction, and the
// receipt then expects the item as both left it.
export async function undoStoredReceipt(ctx: MutationCtx, rawId: string, edit?: CompanionEdit) {
  const row = await loadReceipt(ctx, rawId);
  if (row.state !== "applied") refuse("That completion was already undone.");
  assertCoversEdit(row, edit, "undo");
  const reasons = await receiptProblems(ctx, row, { membership: true });
  if (reasons.length) refuse(refusalMessage("undo", reasons));

  await restoreCompletionReceipt(ctx, row.receipt as PlannerCompletionReceipt);
  await edit?.apply();
  const end = await currentExpectations(ctx, row.expect.map((entry) => entry.nodeId));
  await rewriteChain(ctx, row, "applied", new Map(end.map((entry) => [entry.nodeId, entry.revision])));
  await ctx.db.patch(row._id, {
    state: "undone",
    prev: row.expect.map(({ nodeId, revision }) => ({ nodeId, revision })),
    expect: end,
    updatedAt: Date.now(),
  });
  return { status: "undone" as const, receiptId: row._id, nodeId: row.targetNodeId };
}

// Checked redo: the items must still be the way the undo left them; then the
// completion runs again (`rerun`, with the stored intent, mode and planner)
// and the same receipt records what it did this time. `edit` is redone after
// the check and before the completion, in the same transaction.
export async function redoStoredReceipt(
  ctx: MutationCtx,
  rawId: string,
  rerun: (row: ReceiptRow) => Promise<PlannerCompletionReceipt | null>,
  edit?: CompanionEdit,
) {
  const row = await loadReceipt(ctx, rawId);
  if (row.state !== "undone") refuse("That completion hasn't been undone, so there is nothing to redo.");
  assertCoversEdit(row, edit, "redo");
  const reasons = await receiptProblems(ctx, row, { membership: false });
  if (reasons.length) refuse(refusalMessage("redo", reasons));
  await edit?.apply();

  const tracker = trackNodeWrites(ctx);
  let receipt: PlannerCompletionReceipt | null;
  try {
    receipt = await rerun(row);
  } finally {
    tracker.stop();
  }
  if (!receipt) refuse("Can't redo this completion: the item is already that way or can't be changed now. Nothing was redone.");
  const captured = await captureApplied(ctx, receipt, tracker.writes);
  await rewriteChain(ctx, row, "undone", new Map(captured.expect.map((entry) => [entry.nodeId, entry.revision])));
  await ctx.db.patch(row._id, { state: "applied", receipt, ...captured, updatedAt: Date.now() });
  return { status: "redone" as const, receiptId: row._id, nodeId: row.targetNodeId };
}
