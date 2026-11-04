// Output formatting and input parsing shared by the Flow CLI (scripts/flow.ts)
// and the MCP server (lib/mcp/): readable links, the page outline, data dump
// visibility of a page tree, and recurrence and time values. No I/O except
// through the query function the caller passes in.
import { getDataDumpVisibility } from "../domain/dataDump";
import { collectLinkTargetIds, linkLookup, renderLinks, type LinkLookup, type LinkTargets } from "./links";
import type { PageDoc, TreeNode } from "./logic";

// ---- links ----

// workspace:resolveLinkTargets takes at most this many ids per call.
export const LINK_TARGET_CHUNK = 500;

type QueryFn = (path: string, args: Record<string, unknown>) => Promise<unknown>;

// Resolves every node and page link in `texts` with one
// workspace:resolveLinkTargets call per 500 targets. Hidden targets (excluded
// from data dumps) come back without their text. Throws when the query fails.
export async function resolveLinkLookup(texts: string[], query: QueryFn): Promise<LinkLookup> {
  const { nodeIds, pageIds } = collectLinkTargetIds(texts);
  const targets: LinkTargets = { nodes: [], pages: [] };
  const ids = [...nodeIds.map((id) => ["node", id] as const), ...pageIds.map((id) => ["page", id] as const)];
  for (let i = 0; i < ids.length; i += LINK_TARGET_CHUNK) {
    const chunk = ids.slice(i, i + LINK_TARGET_CHUNK);
    const result = (await query("workspace:resolveLinkTargets", {
      nodeIds: chunk.filter(([kind]) => kind === "node").map(([, id]) => id),
      pageIds: chunk.filter(([kind]) => kind === "page").map(([, id]) => id),
    })) as LinkTargets;
    targets.nodes.push(...result.nodes);
    targets.pages.push(...result.pages);
  }
  return linkLookup(targets);
}

// Item text with readable links, or as stored when there is no lookup.
export const displayText = (text: string, lookup: LinkLookup | null) => (lookup ? renderLinks(text, lookup).displayText : text);

// JSON keeps `text` as stored and adds displayText and links.
export const withLinks = <T extends { text: string }>(item: T, lookup: LinkLookup | null) =>
  lookup ? { ...item, ...renderLinks(item.text, lookup) } : item;

// ---- data dump visibility ----

export type PageTree = { page: PageDoc; nodes: TreeNode[]; loadWarning?: string | null };
// A page tree with data-dump-excluded items (and their subtrees) removed.
// `excludedNodeIds` lets writes refuse ids that point into a hidden subtree.
export type VisibleTree = PageTree & { excludedNodeIds: Set<string> };

// The same rules as the data dump export (getDataDumpVisibility): null for an
// excluded page, otherwise the tree without excluded items and their subtrees.
export function visiblePageTree<T extends PageTree>(result: T): (T & { excludedNodeIds: Set<string> }) | null {
  const visibility = getDataDumpVisibility(result.page, result.nodes);
  if (visibility.pageExcluded) return null;
  return { ...result, nodes: visibility.visibleNodes, excludedNodeIds: visibility.excludedNodeIds };
}

// ---- outline ----

export const taskBox = (node: Pick<TreeNode, "kind" | "taskStatus">) =>
  node.kind === "task" ? (node.taskStatus === "done" ? "[x] " : "[ ] ") : "";

// One outline line: `- [ ] text  (id)`, indented two spaces per level.
export const outlineLine = (node: TreeNode, depth: number, lookup: LinkLookup | null, note = node._id) =>
  `${"  ".repeat(depth)}- ${taskBox(node)}${displayText(node.text, lookup)}  (${note})`;

// The active outline under `parentId` (null: the page's top level), in
// position order, as the lines `tree` prints.
export function outlineLines(nodes: TreeNode[], lookup: LinkLookup | null, parentId: string | null = null, depth = 0) {
  const byParent = new Map<string | null, TreeNode[]>();
  for (const node of nodes.filter((n) => !n.archived)) {
    const list = byParent.get(node.parentNodeId) ?? [];
    list.push(node);
    byParent.set(node.parentNodeId, list);
  }
  const lines: string[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, level: number) => {
    for (const node of [...(byParent.get(parent) ?? [])].sort((a, b) => a.position - b.position)) {
      if (seen.has(node._id)) continue;
      seen.add(node._id);
      lines.push(outlineLine(node, level, lookup));
      walk(node._id, level + 1);
    }
  };
  walk(parentId, depth);
  return lines;
}

// ---- input values ----

// `--recur` / the recur argument: daily|weekly|monthly|yearly, <n>d|w|m|y, or
// none (null). Throws on anything else.
export function parseRecurrence(value: string | undefined) {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  if (["daily", "weekly", "monthly", "yearly"].includes(value)) return value;
  const match = value.match(/^(\d+)([dwmy])$/);
  if (!match || Number(match[1]) < 1) throw new Error(`Bad recurrence "${value}"; use daily|weekly|monthly|yearly, <n>d|w|m|y, or none.`);
  const unit = { d: "day", w: "week", m: "month", y: "year" }[match[2] as "d" | "w" | "m" | "y"];
  return { interval: Number(match[1]), unit };
}

// A 24-hour HH:MM time, or none. Throws on anything else.
export function parseTimeOfDay(value: string) {
  if (value === "none") return null;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error(`Bad time "${value}"; use 24-hour HH:MM or none.`);
  return value;
}
