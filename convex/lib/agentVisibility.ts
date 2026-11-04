// The data dump hiding rule, applied on the server for agent callers (see
// convex/lib/agentRegistry.ts). Same rule as getDataDumpVisibility and the
// export: an excluded page hides everything on it, and an excluded item hides
// its whole subtree. Agents never see hidden items, and writes that touch
// them are refused. Owner callers pass through unchanged.
import { ConvexError } from "convex/values";
import type { DatabaseReader } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { getDataDumpVisibility, isDataDumpExcluded } from "../../lib/domain/dataDump";
import type { Caller } from "./agentAuth";

export const AGENT_EXCLUDED_PAGE_MESSAGE =
  "That page is excluded from data dumps, so agents can't read or change it.";
export const AGENT_EXCLUDED_ITEM_MESSAGE =
  "That item is excluded from data dumps (it, a parent or its page is), so agents can't read or change it.";

// Deep enough for any real outline; a longer chain counts as hidden.
const MAX_ANCESTOR_DEPTH = 200;

// Memoized lookups for many hidden checks in one function call.
export function createHiddenChecker(db: DatabaseReader) {
  const pages = new Map<string, Doc<"pages"> | null>();
  const nodes = new Map<string, Doc<"nodes"> | null>();
  const hiddenByAncestor = new Map<string, boolean>();
  const getPage = async (pageId: Id<"pages">) => {
    if (!pages.has(pageId)) pages.set(pageId, await db.get(pageId));
    return pages.get(pageId) ?? null;
  };
  const getNode = async (nodeId: Id<"nodes">) => {
    if (!nodes.has(nodeId)) nodes.set(nodeId, await db.get(nodeId));
    return nodes.get(nodeId) ?? null;
  };
  // The item, or an ancestor, is excluded (its page isn't checked).
  const isExcludedByItem = async (node: Doc<"nodes">): Promise<boolean> => {
    const chain: string[] = [];
    let current: Doc<"nodes"> | null = node;
    let result = false;
    let depth = 0;
    for (; current && depth < MAX_ANCESTOR_DEPTH; depth += 1) {
      const known = hiddenByAncestor.get(current._id);
      if (known !== undefined) {
        result = known;
        break;
      }
      chain.push(current._id);
      if (isDataDumpExcluded(current)) {
        result = true;
        break;
      }
      current = current.parentNodeId ? await getNode(current.parentNodeId) : null;
    }
    if (depth >= MAX_ANCESTOR_DEPTH) result = true;
    for (const id of chain) hiddenByAncestor.set(id, result);
    return result;
  };
  const isPageHidden = (page: Doc<"pages">) => isDataDumpExcluded(page);
  const isNodeHidden = async (node: Doc<"nodes">) => {
    const page = await getPage(node.pageId);
    return (page !== null && isPageHidden(page)) || (await isExcludedByItem(node));
  };
  return { getPage, getNode, isPageHidden, isNodeHidden, isExcludedByItem };
}

export function agentVisiblePages<T extends Doc<"pages">>(caller: Caller, pages: T[]) {
  return caller.kind === "agent" ? pages.filter((page) => !isDataDumpExcluded(page)) : pages;
}

// A page tree result for this caller: agents get null for an excluded page,
// no excluded items (with their subtrees), and no backlink data.
export function agentVisibleTree<T extends { page: Doc<"pages">; nodes: Doc<"nodes">[] }>(caller: Caller, result: T) {
  if (caller.kind !== "agent") return result;
  const visibility = getDataDumpVisibility(result.page, result.nodes);
  if (visibility.pageExcluded) return null;
  return {
    ...result,
    nodes: visibility.visibleNodes,
    backlinks: [],
    pageBacklinkCount: 0,
    pageBacklinkCountTruncated: false,
    nodeBacklinkCounts: {},
  };
}

export async function agentRefusePage(db: DatabaseReader, caller: Caller, pageId: Id<"pages"> | null | undefined) {
  if (caller.kind !== "agent" || !pageId) return;
  const page = await db.get(pageId);
  if (page && isDataDumpExcluded(page)) throw new ConvexError(AGENT_EXCLUDED_PAGE_MESSAGE);
}

// Refuses when any of these items is hidden. Missing ids pass, so the
// function's own "not found" error still applies.
export async function agentRefuseNodes(
  db: DatabaseReader,
  caller: Caller,
  nodeIds: (Id<"nodes"> | null | undefined)[],
) {
  if (caller.kind !== "agent") return;
  const checker = createHiddenChecker(db);
  for (const nodeId of nodeIds) {
    if (!nodeId) continue;
    const node = await checker.getNode(nodeId);
    if (node && (await checker.isNodeHidden(node))) throw new ConvexError(AGENT_EXCLUDED_ITEM_MESSAGE);
  }
}

// After a write: refuses (so the whole mutation rolls back) when any of these
// items ended up hidden, e.g. added under an excluded section by default.
export async function agentRefuseLanding(db: DatabaseReader, caller: Caller, nodeIds: Id<"nodes">[]) {
  if (caller.kind !== "agent") return;
  const checker = createHiddenChecker(db);
  for (const nodeId of nodeIds) {
    const node = await db.get(nodeId);
    if (node && (await checker.isNodeHidden(node))) throw new ConvexError(AGENT_EXCLUDED_ITEM_MESSAGE);
  }
}

// Refuses undo receipts that touch a hidden item: the completed item, any
// item the undo checks, or any subtree it would delete or restore.
export async function agentRefuseReceipts(db: DatabaseReader, caller: Caller, receiptIds: string[]) {
  if (caller.kind !== "agent") return;
  for (const rawId of receiptIds) {
    const receiptId = db.normalizeId("undoReceipts", rawId);
    const row = receiptId ? await db.get(receiptId) : null;
    if (!row) continue;
    await agentRefuseNodes(db, caller, [
      row.targetNodeId,
      ...row.expect.map((entry) => entry.nodeId),
      ...row.subtrees.flatMap((subtree) => [subtree.rootNodeId, ...subtree.nodeIds]),
    ]);
    if (row.plannerPageId) await agentRefusePage(db, caller, row.plannerPageId);
  }
}
