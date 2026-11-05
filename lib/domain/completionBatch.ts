import { completionIntentFor, completionStateMatches, type CompletionState } from "./workspaceRules";

// The most items one workspace:setNodesCompletion call takes (Convex
// transaction limits). The app refuses bigger selections before sending.
export const MAX_COMPLETION_BATCH = 200;

export type CompletionBatchNode = {
  _id: string;
  kind: string;
  taskStatus?: string | null;
  sourceMeta?: unknown;
  dueAt?: number | null;
  dueEndAt?: number | null;
  revision?: number;
};

export type CompletionBatchItem = {
  nodeId: string;
  intent: "complete" | "reopen";
  expectedRevision: number;
};

export type CompletionBatchResult = {
  status: "applied" | "noop" | "stale";
  message: string | null;
  conflicts: Array<{ nodeId: string; before: CompletionState }>;
  results: Array<{
    nodeId: string;
    status: "applied" | "noop" | "stale";
    receiptId: string | null;
    movesItem: boolean;
  }>;
  receiptIds: string[];
};

// Checks off several items with one setNodesCompletion call. A stale answer
// (nothing written) is retried once with the server's revisions when every
// conflicting item still looks the way the caller saw it, the same rule the
// single-item checkbox uses (completionStateMatches): a text edit doesn't
// block the batch, but a completion made elsewhere is never repeated.
export async function completeNodesInOneCall(
  nodes: CompletionBatchNode[],
  send: (items: CompletionBatchItem[]) => Promise<CompletionBatchResult>,
): Promise<CompletionBatchResult> {
  const items = nodes.map((node) => ({
    nodeId: node._id,
    intent: completionIntentFor(node),
    expectedRevision: node.revision ?? 0,
  }));
  const first = await send(items);
  if (first.status !== "stale") {
    return first;
  }
  const seenById = new Map(nodes.map((node) => [node._id, node]));
  const retryable = first.conflicts.every((conflict) => {
    const seen = seenById.get(conflict.nodeId);
    return seen ? completionStateMatches(seen, conflict.before) : false;
  });
  if (!retryable) {
    return first;
  }
  const revisions = new Map(first.conflicts.map((conflict) => [conflict.nodeId, conflict.before.revision]));
  return await send(items.map((item) => ({ ...item, expectedRevision: revisions.get(item.nodeId) ?? item.expectedRevision })));
}
