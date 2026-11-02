// Workspace rules shared by the web app, the Convex server and the flow CLI:
// page types, locked items, planner completion items, and the task/note toggle.
// One copy, so all three make the same decisions.

export const SIDEBAR_SECTIONS = ["Models", "Tasks", "Notes", "Views", "Templates", "Journal", "Scratchpads"] as const;
export type SidebarSection = (typeof SIDEBAR_SECTIONS)[number];
export type PageType = "default" | "note" | "task" | "planner" | "model" | "journal" | "scratchpad" | "multiPage";

type MetaHolder = { sourceMeta?: unknown } | null | undefined;

export function getNodeMeta(node: MetaHolder): Record<string, unknown> {
  if (!node || typeof node.sourceMeta !== "object" || !node.sourceMeta) return {};
  return node.sourceMeta as Record<string, unknown>;
}

// ---- pages ----

// The page type a new page in a sidebar section gets (the app's + button).
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

export function getPageMeta(page: MetaHolder): { pageType: PageType; sidebarSection: SidebarSection } {
  const meta = getNodeMeta(page);
  const isSidebarPage = meta.specialPage === "sidebar";
  const pageType: PageType = isSidebarPage
    ? "note"
    : meta.pageType === "planner" ||
        meta.pageType === "model" ||
        meta.pageType === "journal" ||
        meta.pageType === "scratchpad" ||
        meta.pageType === "multiPage"
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
      : pageType === "model"
        ? "Models"
        : pageType === "planner"
          ? "Tasks"
          : pageType === "journal"
            ? "Journal"
            : pageType === "scratchpad"
              ? "Scratchpads"
              : pageType === "multiPage"
                ? "Views"
                : pageType === "note"
                  ? "Notes"
                  : "Tasks";
  return { sidebarSection, pageType };
}

// A task page whose completed root tasks move to the Done page.
export function isTaskPageWithDoneArchive(page: MetaHolder) {
  const meta = getNodeMeta(page);
  return meta.specialPage !== "sidebar" && getPageMeta(page).pageType === "task" && meta.archiveCompletedRootTasksToDone === true;
}

// ---- nodes ----

// Section headers and planner days.
export function isNodeLocked(node: MetaHolder) {
  const meta = getNodeMeta(node);
  if (meta.locked !== true) return false;
  return typeof meta.sectionSlot === "string" || meta.plannerKind === "plannerDay";
}

export function isPlannerLinkedTaskCopy(node: MetaHolder) {
  const meta = getNodeMeta(node);
  return meta.plannerKind === "plannerLinkedTask" && typeof meta.sourceTaskNodeId === "string" && meta.sourceTaskNodeId.length > 0;
}

type TreeLike = { parentNodeId?: string | null; sourceMeta?: unknown };

// A planner copy of a task, or anything under a planner day, the Focus
// section or a planner copy: completing it takes the planner path.
export function isPlannerCompletionItem<T extends TreeLike>(node: T | null | undefined, getNode: (id: string) => T | null | undefined) {
  if (!node) return false;
  if (isPlannerLinkedTaskCopy(node)) return true;
  let parentId = (node.parentNodeId as string | null | undefined) ?? null;
  const seen = new Set<string>();
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = getNode(parentId);
    if (!parent) return false;
    const meta = getNodeMeta(parent);
    if (meta.plannerKind === "plannerDay" || meta.sectionSlot === "plannerFocus" || isPlannerLinkedTaskCopy(parent)) return true;
    parentId = (parent.parentNodeId as string | null | undefined) ?? null;
  }
  return false;
}

export function isNodeCompleted(node: { kind: string; taskStatus?: string | null; sourceMeta?: unknown }) {
  return node.kind === "task" ? node.taskStatus === "done" : getNodeMeta(node).noteCompleted === true;
}

// What the app's task/note toggle sends to updateNode (it always locks the
// kind, so AI tagging won't flip it back).
export function kindChangeArgs(node: { kind: string }, kind: "task" | "note") {
  if (node.kind === kind) return { kind, lockKind: true };
  return {
    kind,
    lockKind: true,
    taskStatus: kind === "task" ? ("todo" as const) : null,
    noteCompleted: false,
    dueAt: null,
    dueEndAt: null,
    recurrenceFrequency: null,
  };
}

// The completion-relevant state of an item, as setNodeCompletion reports it.
export type CompletionState = {
  revision: number;
  kind: string;
  taskStatus: string | null;
  noteCompleted: boolean;
  dueAt: number | null;
  dueEndAt: number | null;
  archived?: boolean;
};

type CompletionSource = {
  kind: string;
  taskStatus?: string | null;
  sourceMeta?: unknown;
  dueAt?: number | null;
  dueEndAt?: number | null;
};

// setNodeCompletion refuses a request made against an old revision. A text
// edit also bumps the revision, so a caller whose view of the item still
// matches the server's on everything completion depends on (kind, status,
// dates) may retry with the server's revision. A completion made elsewhere
// changes one of those fields, so it never matches and is never repeated.
export function completionStateMatches(seen: CompletionSource, current: CompletionState) {
  if (current.archived) return false;
  return (
    seen.kind === current.kind &&
    (seen.kind === "task" ? (seen.taskStatus ?? "todo") === (current.taskStatus ?? "todo") : true) &&
    (getNodeMeta(seen).noteCompleted === true) === current.noteCompleted &&
    (seen.dueAt ?? null) === current.dueAt &&
    (seen.dueEndAt ?? null) === current.dueEndAt
  );
}

export function completionIntentFor(node: { kind: string; taskStatus?: string | null; sourceMeta?: unknown }) {
  return isNodeCompleted(node) ? ("reopen" as const) : ("complete" as const);
}
