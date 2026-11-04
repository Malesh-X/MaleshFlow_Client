export type WorkspacePaletteMode =
  | "pages"
  | "find"
  | "nodes"
  | "actions"
  | "replace"
  | "resolveLinks"
  | "archive"
  | "importer"
  | "legacyUpload"
  | "legacySearch"
  | "legacyViewer"
  | "overdueTasks"
  | "waitingTasks"
  | "dataDumpExclusions"
  | "connectedAgents"
  | "taskSchedule"
  | "noteDate";

export type WorkspacePanelLocation = {
  kind: "palette";
  mode: WorkspacePaletteMode;
  nodeId: string | null;
};

export const WORKSPACE_PANEL_SEARCH_PARAM = "panel";
export const WORKSPACE_PANEL_NODE_SEARCH_PARAM = "panelNode";

// Panels that no longer exist. Old bookmarks and history entries may still
// carry them; they open the underlying page instead.
const RETIRED_PANEL_SLUGS = new Set(["ai-chat"]);

const PALETTE_PANEL_SLUG_BY_MODE: Record<WorkspacePaletteMode, string> = {
  pages: "pages",
  find: "find",
  nodes: "items",
  actions: "actions",
  replace: "find-replace",
  resolveLinks: "resolve-links",
  archive: "archive-search",
  importer: "import-text",
  legacyUpload: "legacy-upload",
  legacySearch: "legacy-search",
  legacyViewer: "legacy-viewer",
  overdueTasks: "past-due",
  waitingTasks: "waiting",
  dataDumpExclusions: "data-dump-exclusions",
  connectedAgents: "connected-agents",
  taskSchedule: "task-schedule",
  noteDate: "note-date",
};

const PALETTE_MODE_BY_PANEL_SLUG = new Map(
  Object.entries(PALETTE_PANEL_SLUG_BY_MODE).map(([mode, slug]) => [
    slug,
    mode as WorkspacePaletteMode,
  ]),
);

export function readWorkspacePanelLocation(
  searchParams: Pick<URLSearchParams, "get">,
): WorkspacePanelLocation | null {
  const panel = searchParams.get(WORKSPACE_PANEL_SEARCH_PARAM)?.trim() ?? "";
  const mode = PALETTE_MODE_BY_PANEL_SLUG.get(panel) ?? null;
  if (!mode) {
    return null;
  }

  return {
    kind: "palette",
    mode,
    nodeId:
      searchParams.get(WORKSPACE_PANEL_NODE_SEARCH_PARAM)?.trim() || null,
  };
}

export function writeWorkspacePanelLocation(
  searchParams: URLSearchParams,
  location: WorkspacePanelLocation | null,
) {
  if (!location) {
    searchParams.delete(WORKSPACE_PANEL_SEARCH_PARAM);
    searchParams.delete(WORKSPACE_PANEL_NODE_SEARCH_PARAM);
    return;
  }

  searchParams.set(
    WORKSPACE_PANEL_SEARCH_PARAM,
    PALETTE_PANEL_SLUG_BY_MODE[location.mode],
  );
  if (location.nodeId) {
    searchParams.set(WORKSPACE_PANEL_NODE_SEARCH_PARAM, location.nodeId);
  } else {
    searchParams.delete(WORKSPACE_PANEL_NODE_SEARCH_PARAM);
  }
}

// Removes a retired panel (and its node param) from the search params, leaving
// the page, focused node and anything else in place. Returns whether it did.
export function clearRetiredWorkspacePanel(searchParams: URLSearchParams) {
  const panel = searchParams.get(WORKSPACE_PANEL_SEARCH_PARAM)?.trim() ?? "";
  if (!RETIRED_PANEL_SLUGS.has(panel)) {
    return false;
  }

  searchParams.delete(WORKSPACE_PANEL_SEARCH_PARAM);
  searchParams.delete(WORKSPACE_PANEL_NODE_SEARCH_PARAM);
  return true;
}
