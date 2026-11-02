// Pure helpers for scripts/flow.ts (no I/O, so they can be unit tested).
//
// Several of these mirror private functions in components/WorkspaceApp.tsx
// (getPageMeta, isNodeLocked, the handleCreatePage section map, the kind
// toggle). They aren't exported from the app, and the CLI must not change the
// app, so they are copied here with a pointer to the original. Phase 3 of
// docs/server-logic-plan.md moves these rules into Convex and removes the copies.
import { dateInputValueToTimestamp, timestampToDateInputValue } from "../lib/domain/recurrence";

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
};

export type PageDoc = { _id: string; title: string; archived?: boolean; sourceMeta?: Record<string, unknown> | null };

export const SIDEBAR_SECTIONS = ["Models", "Tasks", "Notes", "Views", "Templates", "Journal", "Scratchpads"] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
export type PageType = "default" | "note" | "task" | "planner" | "model" | "journal" | "scratchpad" | "multiPage";

export const metaOf = (value: { sourceMeta?: unknown } | null | undefined): Record<string, unknown> =>
  value && typeof value.sourceMeta === "object" && value.sourceMeta ? (value.sourceMeta as Record<string, unknown>) : {};

// ---- pages ----

// Mirrors the section -> pageType map in handleCreatePage (WorkspaceApp.tsx).
export function pageTypeForSection(section: SidebarSection): PageType {
  switch (section) {
    case "Models":
      return "model";
    case "Tasks":
      return "task";
    case "Notes":
      return "note";
    case "Views":
      return "multiPage";
    case "Journal":
      return "journal";
    case "Scratchpads":
      return "scratchpad";
    default:
      return "default";
  }
}

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

// Mirrors getPageMeta in WorkspaceApp.tsx.
export function getPageMeta(page: { sourceMeta?: unknown } | null | undefined): { pageType: PageType; sidebarSection: SidebarSection } {
  const meta = metaOf(page);
  const isSidebarPage = meta.specialPage === "sidebar";
  const pageType: PageType = isSidebarPage
    ? "note"
    : meta.pageType === "planner" || meta.pageType === "model" || meta.pageType === "journal" || meta.pageType === "scratchpad" || meta.pageType === "multiPage"
      ? (meta.pageType as PageType)
      : meta.pageType === "note" || meta.sidebarSection === "Notes"
        ? "note"
        : meta.pageType === "task" || meta.sidebarSection === "Tasks"
          ? "task"
          : "default";
  const sidebarSection: SidebarSection = SIDEBAR_SECTIONS.includes(meta.sidebarSection as SidebarSection)
    ? (meta.sidebarSection as SidebarSection)
    : isSidebarPage
      ? "Notes"
      : ({ model: "Models", planner: "Tasks", journal: "Journal", scratchpad: "Scratchpads", multiPage: "Views", note: "Notes" } as Partial<Record<PageType, SidebarSection>>)[pageType] ?? "Tasks";
  return { pageType, sidebarSection };
}

// Where a new item goes when `add` has no --parent: the page's main section
// (the one the app adds into), the page root, or nowhere (planner pages).
export function primarySectionSlot(page: { sourceMeta?: unknown }): string | "root" | "requireParent" {
  const { pageType, sidebarSection } = getPageMeta(page);
  switch (pageType) {
    case "planner":
      return "requireParent";
    case "note":
      return "noteMain";
    case "journal":
      return "journalThoughts";
    case "scratchpad":
      return "scratchpadLive";
    case "model":
      return "model";
    case "multiPage":
      return "multiPageIncludedPages";
    case "default":
      return sidebarSection === "Templates" ? "templateMain" : "root";
    default:
      return "root";
  }
}

export function findSectionNode(nodes: TreeNode[], slot: string) {
  return nodes.find((node) => !node.archived && node.parentNodeId === null && metaOf(node).sectionSlot === slot) ?? null;
}

// ---- nodes ----

// Mirrors isNodeLocked in WorkspaceApp.tsx: section headers and planner days.
export function isNodeLocked(node: { sourceMeta?: unknown } | null | undefined) {
  const meta = metaOf(node);
  if (meta.locked !== true) return false;
  return typeof meta.sectionSlot === "string" || meta.plannerKind === "plannerDay";
}

export function isNodeCompleted(node: TreeNode) {
  return node.kind === "task" ? node.taskStatus === "done" : metaOf(node).noteCompleted === true;
}

// Mirrors isPlannerLinkedTaskCopy / isPlannerCompletionItem in WorkspaceApp.tsx.
export function isPlannerLinkedTaskCopy(node: TreeNode) {
  const meta = metaOf(node);
  return meta.plannerKind === "plannerLinkedTask" && typeof meta.sourceTaskNodeId === "string" && meta.sourceTaskNodeId.length > 0;
}
export function isPlannerCompletionItem(node: TreeNode, nodeMap: Map<string, TreeNode>) {
  if (isPlannerLinkedTaskCopy(node)) return true;
  let parentId = node.parentNodeId;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = nodeMap.get(parentId);
    if (!parent) return false;
    const meta = metaOf(parent);
    if (meta.plannerKind === "plannerDay" || meta.sectionSlot === "plannerFocus" || isPlannerLinkedTaskCopy(parent)) return true;
    parentId = parent.parentNodeId;
  }
  return false;
}

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

// What the app's task/note toggle sends (WorkspaceApp.tsx, toggle kind).
export function kindChangeArgs(node: TreeNode, kind: "task" | "note") {
  if (node.kind === kind) return { kind, lockKind: true };
  return {
    kind,
    lockKind: true,
    taskStatus: kind === "task" ? "todo" : null,
    noteCompleted: false,
    dueAt: null,
    dueEndAt: null,
    recurrenceFrequency: null,
  };
}
