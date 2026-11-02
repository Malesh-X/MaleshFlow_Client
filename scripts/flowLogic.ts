// Pure helpers for scripts/flow.ts (no I/O, so they can be unit tested).
// Workspace rules (page types, locks, planner items, kind toggle) come from
// lib/domain/workspaceRules.ts, the same module the app and server use.
import { parseImportedTextToOutlineNodes, type ImportedOutlineNode } from "../lib/domain/importer";
import { dateInputValueToTimestamp, timestampToDateInputValue } from "../lib/domain/recurrence";
import { getNodeMeta, pageTypeForSection, type PageType, type SidebarSection } from "../lib/domain/workspaceRules";

export {
  SIDEBAR_SECTIONS,
  getPageMeta,
  isNodeCompleted,
  isNodeLocked,
  isPlannerCompletionItem,
  isPlannerLinkedTaskCopy,
  kindChangeArgs,
  pageTypeForSection,
  primarySectionSlot,
  type PageType,
  type SidebarSection,
} from "../lib/domain/workspaceRules";

export type TreeNode = {
  _id: string;
  pageId: string;
  parentNodeId: string | null;
  position: number;
  text: string;
  kind: string;
  taskStatus: string | null;
  archived: boolean;
  dueAt?: number | null;
  dueEndAt?: number | null;
  dueTime?: string | null;
  dueTimeZone?: string | null;
  sourceMeta?: Record<string, unknown> | null;
  revision?: number;
};

export type PageDoc = { _id: string; title: string; archived?: boolean; sourceMeta?: Record<string, unknown> | null };

export const metaOf = getNodeMeta;

// ---- pages ----

// Arguments for workspace:createPage, matching what the app sends.
export function createPageArgs(title: string, section: SidebarSection, type?: "planner") {
  if (type === "planner") return { title, sidebarSection: section, pageType: "planner" as PageType };
  return {
    title,
    sidebarSection: section,
    pageType: pageTypeForSection(section),
    ...(section === "Journal" ? { addToLatestJournalView: true } : {}),
  };
}

// Where a new item goes when `add` has no --parent: the page's main section
// (the one the app adds into), the page root, or nowhere (planner pages).

export function findSectionNode(nodes: TreeNode[], slot: string) {
  return nodes.find((node) => !node.archived && node.parentNodeId === null && metaOf(node).sectionSlot === slot) ?? null;
}

// Page types whose sidebar section gives them sections; a "default" page there
// was created without its type (old CLI add-page) and never got them.
const TYPED_SECTIONS: Partial<Record<SidebarSection, PageType>> = {
  Models: "model",
  Journal: "journal",
  Views: "multiPage",
  Scratchpads: "scratchpad",
};
export function isUntypedSectionPage(page: PageDoc) {
  const meta = metaOf(page);
  const section = meta.sidebarSection as SidebarSection;
  if (!TYPED_SECTIONS[section] || meta.specialPage === "sidebar") return false;
  return meta.pageType === undefined || meta.pageType === null || meta.pageType === "default";
}

// ---- nodes ----

// Ids of every node under rootId (not including rootId).
export function collectDescendantIds(nodes: TreeNode[], rootId: string) {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentNodeId) continue;
    const list = children.get(node.parentNodeId) ?? [];
    list.push(node._id);
    children.set(node.parentNodeId, list);
  }
  const result = new Set<string>();
  const stack = [...(children.get(rootId) ?? [])];
  while (stack.length) {
    const id = stack.pop()!;
    if (result.has(id)) continue;
    result.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return result;
}

// Checks a new parent for nodeId. `targetNodes` is the active tree of the page
// the node will end up on; `descendantIds` are the moving node's descendants.
// Returns an error message, or null when the parent is fine.
export function validateParent(args: {
  nodeId: string | null;
  parentId: string | null;
  targetNodes: TreeNode[];
  descendantIds?: Set<string>;
}) {
  const { nodeId, parentId, targetNodes, descendantIds } = args;
  if (parentId === null) return null;
  if (nodeId !== null && parentId === nodeId) return "An item can't be its own parent.";
  if (descendantIds?.has(parentId)) return "That parent is inside the item you're moving (it would create a loop).";
  const parent = targetNodes.find((node) => node._id === parentId);
  if (!parent) return "That parent isn't an active item on the destination page.";
  return null;
}

// Active nodes whose parent isn't an active node on the same page (archived,
// missing, or on another page). The app shows these as stray roots.
export function findStrayNodes(nodes: TreeNode[]) {
  const activeIds = new Set(nodes.filter((node) => !node.archived).map((node) => node._id));
  return nodes.filter((node) => !node.archived && node.parentNodeId !== null && !activeIds.has(node.parentNodeId));
}

export type ParentLookup = { pageId: string | null; archived: boolean } | null;
// "notLoaded": the parent is active on the same page but wasn't in the loaded
// tree (the page tree is capped), so it isn't damage.
export function classifyStrayParent(nodePageId: string, parent: ParentLookup): "missing" | "archived" | "otherPage" | "notLoaded" {
  if (!parent || !parent.pageId) return "missing";
  if (parent.pageId !== nodePageId) return "otherPage";
  return parent.archived ? "archived" : "notLoaded";
}

// The id `add --parent` places a new item after: the parent's last child
// (archived ones included, since the server appends after them too), or
// undefined when it has none.
export function lastChildId(nodes: TreeNode[], parentId: string) {
  const children = nodes.filter((node) => node.parentNodeId === parentId).sort((a, b) => a.position - b.position);
  return children.at(-1)?._id;
}

// ---- outlines ----

// workspace:createNodesBatch entries for an outline, parsed with the app's
// importer (lib/domain/importer.ts): "[ ]" / "[x]" tasks, due markers like
// "!(2026-11-15)" or "!(2026-11-15 - 2026-11-17 | 1w)", recurrence and the
// kind lock, the same as pasting into the app's importer. Top-level entries
// name no parent, so the server adds them to the page's primary section.
export function outlineBatchEntries(markdown: string) {
  const entries: Record<string, unknown>[] = [];
  let counter = 0;
  const append = (node: ImportedOutlineNode, placement: { parentClientId?: string; afterClientId?: string; afterNodeId?: null }) => {
    const clientId = `c${counter++}`;
    entries.push({
      clientId,
      ...placement,
      text: node.text,
      kind: node.kind,
      ...(node.taskStatus ? { taskStatus: node.taskStatus } : {}),
      ...(node.noteCompleted ? { noteCompleted: true } : {}),
      ...(node.dueAt !== null ? { dueAt: node.dueAt } : {}),
      ...(node.dueEndAt !== null ? { dueEndAt: node.dueEndAt } : {}),
      ...(node.recurrenceFrequency !== null ? { recurrenceFrequency: node.recurrenceFrequency } : {}),
      lockKind: node.lockKind,
    });
    let previousChild: string | undefined;
    for (const child of node.children) {
      // The first child goes first under its new parent; later ones follow.
      previousChild = append(child, { parentClientId: clientId, ...(previousChild ? { afterClientId: previousChild } : { afterNodeId: null }) });
    }
    return clientId;
  };
  let previousRoot: string | undefined;
  for (const node of parseImportedTextToOutlineNodes(markdown)) {
    previousRoot = append(node, previousRoot ? { afterClientId: previousRoot } : {});
  }
  return entries;
}

// ---- schedules ----

// YYYY-MM-DD -> local noon, like the app's date picker (dateInputValueToTimestamp).
// Returns null for "none", undefined when not given, and throws on a bad date.
export function parseDueDate(value: string | undefined) {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(value) ? dateInputValueToTimestamp(value) : null;
  if (ms === null || timestampToDateInputValue(ms) !== value) throw new Error(`Bad date "${value}"; use YYYY-MM-DD or none.`);
  return ms;
}

// The schedule fields an update sends for a --due value, like the app's
// schedule panel: clearing removes all five fields, and a new due date drops an
// end date that isn't after it.
export function scheduleForDue(dueAt: number | null, existing: { dueEndAt?: number | null }) {
  if (dueAt === null) return { dueAt: null, dueEndAt: null, dueTime: null, dueTimeZone: null, recurrenceFrequency: null };
  const endAt = existing.dueEndAt ?? null;
  return { dueAt, ...(endAt !== null && endAt <= dueAt ? { dueEndAt: null } : {}) };
}

// ---- doctor checks (read-only) ----

export type DoctorFinding = { pageId: string; pageTitle: string; nodeId?: string; text: string; detail?: string };

export const noteHasTaskStatus = (node: TreeNode) => !node.archived && node.kind !== "task" && node.taskStatus !== null && node.taskStatus !== undefined;
export const recurringWithoutDue = (node: TreeNode) => !node.archived && metaOf(node).recurrenceFrequency != null && !node.dueAt;
export const endNotAfterDue = (node: TreeNode) =>
  !node.archived && node.dueEndAt != null && (node.dueAt == null || node.dueEndAt <= node.dueAt);

export function nodeChecks(page: PageDoc, nodes: TreeNode[]) {
  const finding = (node: TreeNode, detail?: string): DoctorFinding => ({
    pageId: page._id,
    pageTitle: page.title,
    nodeId: node._id,
    text: node.text,
    ...(detail ? { detail } : {}),
  });
  const day = (ms: number | null | undefined) => (ms ? timestampToDateInputValue(ms) : "none");
  return {
    notesWithTaskStatus: nodes.filter(noteHasTaskStatus).map((node) => finding(node, `taskStatus ${node.taskStatus}`)),
    recurringWithoutDue: nodes.filter(recurringWithoutDue).map((node) => finding(node, JSON.stringify(metaOf(node).recurrenceFrequency))),
    endNotAfterDue: nodes.filter(endNotAfterDue).map((node) => finding(node, `due ${day(node.dueAt)}, end ${day(node.dueEndAt)}`)),
  };
}
