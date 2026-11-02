// Every public mutation in convex/ is listed here, as guarded or exempt.
// tests/guardCoverage.test.ts fails when a public mutation is in neither list,
// so a new mutation can't skip the guards by accident.
//
// "guarded": its handler (or a helper listed in `via`) calls at least one of
// assertNodeEditable, assertValidParent, assertPageWritable or normalizeSchedule.
// Every public mutation, guarded or exempt, starts with withGuards(), so node
// writes always bump the revision counter.

export type GuardedEntry = { checks: string; via?: string[] };

export const GUARDED_MUTATIONS: Record<string, GuardedEntry> = {
  "workspace:createNode": { checks: "page writable, parent valid, schedule" },
  "workspace:createNodesBatch": { checks: "page writable, each existing parent valid, schedule per entry" },
  "workspace:updateNode": { checks: "node editable (kind/status locks, archived page), schedule" },
  "workspace:updateNodesBatch": { checks: "node editable per update, schedule per update" },
  "workspace:insertNodeAbove": { checks: "node editable" },
  "workspace:splitNode": { checks: "node editable" },
  "workspace:replaceNodeAndInsertSiblings": { checks: "node editable" },
  "workspace:moveNodeTree": {
    checks: "per branch: node movable, destination page writable, parent valid; broken trees refused outright",
    via: ["moveNodeTreeCore"],
  },
  "workspace:moveNode": { checks: "node movable, destination page writable, parent valid (same page, no loop)", via: ["moveNodeTreeCore"] },
  "workspace:moveNodesBatch": { checks: "per move: node movable, destination page writable, parent valid", via: ["moveNodeTreeCore"] },
  "workspace:reorderNode": { checks: "node movable" },
  "workspace:moveNodeTreesToPage": { checks: "each node movable (destination page already checked)", via: ["moveNodeTreeCore"] },
  "workspace:archiveNode": { checks: "node archivable / unarchivable" },
  "workspace:setNodeTreeArchived": { checks: "node archivable / unarchivable" },
  "workspace:setNodeTreesArchivedBatch": { checks: "each node archivable / unarchivable" },
  "workspace:forceArchiveTaskPageItem": { checks: "node archivable" },
  "workspace:deleteNode": { checks: "node deletable" },
  "workspace:completeTaskPageTask": { checks: "node status editable (legacy adapter for old tabs)" },
  "workspace:setNodeCompletion": { checks: "node status editable; planner page writable for previews" },
  "workspace:applyFindAndReplaceBatch": { checks: "each replaced node editable" },
  "workspace:renamePage": { checks: "page writable" },
  "workspace:setNodeChildrenLinkAutocompleteHidden": { checks: "node editable" },
  "workspace:setNodeDataDumpExcluded": { checks: "each node editable" },
  "workspace:setPlannerScanExcluded": { checks: "page writable" },
  "workspace:setTaskPageDoneArchiveEnabled": { checks: "page writable" },
  "workspace:setPageDataDumpExcluded": { checks: "page writable" },
  "workspace:setModelPageCustomPrompt": { checks: "page writable" },
  "planner:setPlannerStartDate": { checks: "page writable" },
  "planner:appendPlannerDay": { checks: "page writable" },
  "planner:addRandomPlannerTask": { checks: "page writable" },
  "planner:addPlannerSourceTask": { checks: "page writable" },
  "planner:reorderPlannerDay": { checks: "page writable" },
  "planner:reorderPlannerFocusSection": { checks: "page writable" },
  "planner:resolveNextPlannerTask": { checks: "page writable" },
  "planner:completePlannerTask": { checks: "planner item status editable" },
  "planner:completePlannerSourceTask": { checks: "planner page writable, source task status editable" },
  "planner:completePlannerDay": { checks: "page writable" },
  "chatData:applyApprovedChatPlan": {
    checks: "per operation: create (page, parent), update (node editable, schedule), move (node, page, parent), archive, delete, merge",
    via: ["applyOperation"],
  },
  "chatData:applyApprovedPlannerPlan": {
    checks: "per operation: complete (status), delete, update (text), move (node, parent)",
    via: ["applyPlannerOperation"],
  },
};

export const EXEMPT_MUTATIONS: Record<string, string> = {
  "workspace:createPage": "Creates a new page and its own system sections; there is no existing item, parent or schedule to check.",
  "workspace:archivePage": "Page lifecycle: archiving and restoring must work on archived pages by design.",
  "workspace:deletePageForever": "Irreversible page deletion with its own server-side checks (archived pages only).",
  "workspace:ensureSidebarPage": "System maintenance: creates the sidebar page if missing.",
  "workspace:ensureTaskPageSidebarSection": "System maintenance: creates a missing locked section.",
  "workspace:ensurePlannerPageSections": "System maintenance: creates missing locked planner sections.",
  "workspace:ensureJournalPageSections": "System maintenance: creates missing locked journal sections.",
  "workspace:ensureNotePageSections": "System maintenance: creates missing locked note sections and files stray roots under them.",
  "workspace:ensureScratchpadPageSections": "System maintenance: creates missing locked scratchpad sections.",
  "workspace:ensureTemplatePageSections": "System maintenance: creates missing locked template sections.",
  "workspace:ensureMultiPagePageSections": "System maintenance: creates the missing locked view section.",
  "planner:ensurePlannerPageSections": "System maintenance: creates missing locked planner sections.",
  "workspace:refreshSidebarLinks": "System maintenance: rebuilds sidebar link rows.",
  "workspace:rebuildEmbeddings": "System maintenance: queues embedding jobs; no node or page edits.",
  "workspace:cancelEmbeddingRebuild": "System maintenance: embedding job state only.",
  "workspace:checkOwnerKey": "Auth check; writes the lockout throttle only.",
  "workspace:setWorkspaceSettings": "Workspace settings (time zone, completion mode); no tree edits.",
  "workspace:setWorkspaceAiMemory": "Workspace AI memory text; no tree edits.",
  "workspace:setWorkspaceInbox": "Inbox box text; the Inbox is being removed (out of scope).",
  "workspace:clearWorkspaceInbox": "Inbox box text and its history page; the Inbox is being removed (out of scope).",
  "workspace:setWorkspaceRandomBox": "Random Box text; being removed (out of scope).",
  "workspace:replaceUnresolvedPageLinksWithTarget": "Link maintenance: rewrites link markup in text only.",
  "workspace:replaceUnresolvedPageLinksWithNode": "Link maintenance: rewrites link markup in text only.",
  "workspace:setPagePinnedInAllSidebar": "Sidebar display setting; no tree, schedule or status change.",
  "workspace:mergePinnedPagesInAllSidebar": "Sidebar display setting; no tree, schedule or status change.",
  "workspace:setSidebarFavorite": "Sidebar favorites table only.",
  "planner:undoCompletePlannerTask": "Undo restores recorded before-states; Phase 4 adds conflict checks to receipts.",
  "chatData:ensureChatThread": "Chat tables only.",
  "chatData:ensureWorkspaceKnowledgeThread": "Chat tables only.",
  "calendar:ensureTaskCalendarFeed": "Calendar feed table only.",
  "calendar:rotateTaskCalendarFeed": "Calendar feed table only.",
  "legacy:generateLegacyUploadUrl": "File upload URL; no data writes.",
  "legacy:registerLegacyFile": "Legacy file table only.",
  "migrationData:updateMigrationLessonsDoc": "Import/migration bookkeeping (lessons doc).",
  "migrationData:abandonMigrationRun": "Import/migration run state only.",
  "migrationData:skipMigrationChunk": "Import/migration chunk state only.",
};

export const GUARD_FUNCTION_NAMES = ["assertNodeEditable", "assertValidParent", "assertPageWritable", "normalizeSchedule"] as const;
