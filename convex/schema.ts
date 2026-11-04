import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import {
  nodeKindValidator,
  nullableNodeIdValidator,
  nullablePageIdValidator,
  priorityValidator,
  taskStatusValidator,
} from "./lib/validators";

export default defineSchema({
  pages: defineTable({
    title: v.string(),
    slug: v.string(),
    icon: v.union(v.string(), v.null()),
    archived: v.boolean(),
    position: v.number(),
    sourceMeta: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_archived_position", ["archived", "position"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["archived"],
    }),

  nodes: defineTable({
    pageId: v.id("pages"),
    parentNodeId: nullableNodeIdValidator,
    position: v.number(),
    text: v.string(),
    kind: nodeKindValidator,
    taskStatus: taskStatusValidator,
    priority: priorityValidator,
    dueAt: v.union(v.number(), v.null()),
    dueEndAt: v.optional(v.union(v.number(), v.null())),
    dueTime: v.optional(v.union(v.string(), v.null())),
    dueTimeZone: v.optional(v.union(v.string(), v.null())),
    archived: v.boolean(),
    sourceMeta: v.optional(v.any()),
    // Bumped on every write through the guarded mutations (convex/lib/guards.ts).
    revision: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_page_parent_position", ["pageId", "parentNodeId", "position"])
    .index("by_page_archived", ["pageId", "archived"])
    .index("by_kind_status", ["kind", "taskStatus", "archived"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["pageId", "archived", "kind"],
    }),

  sidebarFavorites: defineTable({
    targetKind: v.union(v.literal("page"), v.literal("node")),
    targetPageId: v.id("pages"),
    targetNodeId: v.union(v.id("nodes"), v.null()),
    position: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_position", ["position"])
    .index("by_target", ["targetKind", "targetPageId", "targetNodeId"]),

  links: defineTable({
    sourcePageId: nullablePageIdValidator,
    sourceNodeId: nullableNodeIdValidator,
    targetPageId: nullablePageIdValidator,
    targetNodeId: nullableNodeIdValidator,
    targetPageTitle: v.union(v.string(), v.null()),
    targetNodeRef: v.union(v.string(), v.null()),
    label: v.string(),
    kind: v.union(v.literal("page"), v.literal("node")),
    resolved: v.boolean(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_source_page", ["sourcePageId"])
    .index("by_source_node", ["sourceNodeId"])
    .index("by_target_page", ["targetPageId"])
    .index("by_target_node", ["targetNodeId"])
    .index("by_target_node_ref", ["targetNodeRef"]),

  chatThreads: defineTable({
    pageId: nullablePageIdValidator,
    title: v.string(),
    scope: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_page_updatedAt", ["pageId", "updatedAt"])
    .index("by_updatedAt", ["updatedAt"]),

  chatMessages: defineTable({
    threadId: v.id("chatThreads"),
    role: v.union(
      v.literal("system"),
      v.literal("user"),
      v.literal("assistant"),
    ),
    text: v.string(),
    preview: v.optional(v.array(v.string())),
    proposedPlan: v.optional(v.any()),
    metadata: v.optional(v.any()),
    status: v.union(
      v.literal("ready"),
      v.literal("pending_approval"),
      v.literal("applied"),
      v.literal("error"),
    ),
    error: v.optional(v.string()),
    createdAt: v.number(),
    appliedAt: v.optional(v.number()),
  })
    .index("by_thread_createdAt", ["threadId", "createdAt"])
    .index("by_status_createdAt", ["status", "createdAt"]),

  calendarFeeds: defineTable({
    kind: v.union(v.literal("task_ics")),
    token: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_kind", ["kind"])
    .index("by_token", ["token"]),

  imports: defineTable({
    sourceType: v.string(),
    status: v.union(
      v.literal("processing"),
      v.literal("completed"),
      v.literal("error"),
    ),
    originalFiles: v.array(v.string()),
    warnings: v.array(v.string()),
    fileCount: v.number(),
    importedPageCount: v.number(),
    importedNodeCount: v.number(),
    summary: v.optional(v.string()),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
  }).index("by_createdAt", ["createdAt"]),

  legacyFiles: defineTable({
    storageId: v.id("_storage"),
    fileName: v.string(),
    filePath: v.string(),
    extension: v.string(),
    mimeType: v.union(v.string(), v.null()),
    size: v.number(),
    status: v.union(
      v.literal("uploaded"),
      v.literal("processing"),
      v.literal("ready"),
      v.literal("error"),
    ),
    error: v.union(v.string(), v.null()),
    chunkCount: v.number(),
    semanticStatus: v.union(
      v.literal("none"),
      v.literal("queued"),
      v.literal("processing"),
      v.literal("ready"),
      v.literal("error"),
    ),
    semanticError: v.union(v.string(), v.null()),
    semanticChunkCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_updated_at", ["updatedAt"])
    .index("by_status_and_updated_at", ["status", "updatedAt"]),

  legacyChunks: defineTable({
    fileId: v.id("legacyFiles"),
    chunkIndex: v.number(),
    text: v.string(),
    lineStart: v.number(),
    lineEnd: v.number(),
    charStart: v.number(),
    charEnd: v.number(),
    createdAt: v.number(),
  })
    .index("by_file_and_chunk_index", ["fileId", "chunkIndex"])
    .searchIndex("search_text", {
      searchField: "text",
      filterFields: ["fileId"],
    }),

  legacyChunkEmbeddings: defineTable({
    chunkId: v.id("legacyChunks"),
    fileId: v.id("legacyFiles"),
    chunkIndex: v.number(),
    model: v.string(),
    vector: v.array(v.float64()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_chunk", ["chunkId"])
    .index("by_file_and_chunk_index", ["fileId", "chunkIndex"])
    .vectorIndex("by_embedding", {
      vectorField: "vector",
      dimensions: 1536,
      filterFields: ["fileId"],
    }),

  migrationRuns: defineTable({
    sourceType: v.union(
      v.literal("dynalist"),
      v.literal("workflowy"),
      v.literal("logseq"),
    ),
    status: v.union(
      v.literal("draft"),
      v.literal("reviewing"),
      v.literal("completed"),
      v.literal("abandoned"),
      v.literal("error"),
    ),
    title: v.string(),
    sourceSummary: v.string(),
    lessonsDoc: v.string(),
    totalChunks: v.number(),
    readyChunks: v.number(),
    reviewChunks: v.number(),
    appliedChunks: v.number(),
    skippedChunks: v.number(),
    errorChunks: v.number(),
    sourceDocumentCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_createdAt", ["createdAt"])
    .index("by_status_updatedAt", ["status", "updatedAt"]),

  migrationLessons: defineTable({
    sourceType: v.union(
      v.literal("dynalist"),
      v.literal("workflowy"),
      v.literal("logseq"),
    ),
    lessonsDoc: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_source_type", ["sourceType"]),

  migrationSourceDocuments: defineTable({
    runId: v.id("migrationRuns"),
    sourceType: v.union(
      v.literal("dynalist"),
      v.literal("workflowy"),
      v.literal("logseq"),
    ),
    sourceDocumentId: v.string(),
    title: v.string(),
    sourcePath: v.string(),
    detectedJournalDate: v.union(v.string(), v.null()),
    order: v.number(),
    metadata: v.optional(v.any()),
    carryForwardPlan: v.optional(v.any()),
    destinationPageId: v.union(v.id("pages"), v.null()),
    destinationPageTitle: v.union(v.string(), v.null()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_run_and_order", ["runId", "order"])
    .index("by_run_and_source_document_id", ["runId", "sourceDocumentId"]),

  migrationChunks: defineTable({
    runId: v.id("migrationRuns"),
    sourceDocumentEntryId: v.id("migrationSourceDocuments"),
    sourceDocumentId: v.string(),
    order: v.number(),
    lineCount: v.number(),
    ancestorChain: v.any(),
    roots: v.any(),
    status: v.union(
      v.literal("pending"),
      v.literal("ready"),
      v.literal("needs_review"),
      v.literal("approved"),
      v.literal("applied"),
      v.literal("skipped"),
      v.literal("error"),
    ),
    chunkText: v.string(),
    preview: v.array(v.string()),
    suggestion: v.optional(v.any()),
    approvedPlan: v.optional(v.any()),
    guidance: v.optional(v.string()),
    matchedExampleId: v.union(v.id("migrationExamples"), v.null()),
    createdPageId: v.union(v.id("pages"), v.null()),
    createdNodeCount: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
    appliedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  })
    .index("by_run_and_order", ["runId", "order"])
    .index("by_run_and_status_and_order", ["runId", "status", "order"])
    .index("by_source_document_entry_and_order", ["sourceDocumentEntryId", "order"]),

  migrationExamples: defineTable({
    sourceType: v.union(
      v.literal("dynalist"),
      v.literal("workflowy"),
      v.literal("logseq"),
    ),
    summary: v.string(),
    chunkText: v.string(),
    guidance: v.string(),
    approvedPlan: v.any(),
    vector: v.array(v.float64()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_source_type_createdAt", ["sourceType", "createdAt"])
    .vectorIndex("by_embedding", {
      vectorField: "vector",
      dimensions: 1536,
      filterFields: ["sourceType"],
    }),

  embeddingJobs: defineTable({
    nodeId: v.id("nodes"),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("error"),
    ),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    lastQueuedAt: v.number(),
    lastEmbeddedHash: v.optional(v.string()),
    lastEmbeddedPageId: v.optional(v.id("pages")),
    lastEmbeddedAt: v.optional(v.number()),
    rebuildRunId: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_node", ["nodeId"])
    .index("by_status_updatedAt", ["status", "updatedAt"])
    .index("by_rebuildRunId", ["rebuildRunId"]),

  embeddingRebuildState: defineTable({
    key: v.string(),
    runId: v.string(),
    status: v.union(
      v.literal("idle"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("error"),
      v.literal("cancelled"),
    ),
    scanComplete: v.boolean(),
    scannedNodes: v.number(),
    eligibleNodes: v.number(),
    skippedNodes: v.number(),
    queued: v.number(),
    running: v.number(),
    completed: v.number(),
    error: v.number(),
    lastQueuedAt: v.union(v.number(), v.null()),
    startedAt: v.number(),
    updatedAt: v.number(),
    finishedAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
  }).index("by_key", ["key"]),

  nodeEmbeddings: defineTable({
    nodeId: v.id("nodes"),
    pageId: v.id("pages"),
    content: v.string(),
    vector: v.array(v.float64()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_node", ["nodeId"])
    .index("by_page", ["pageId"])
    .vectorIndex("by_embedding", {
      vectorField: "vector",
      dimensions: 1536,
      filterFields: ["pageId"],
    }),

  // OAuth for agents (MCP connectors): see convex/oauth.ts and docs/mcp.md.
  // Codes and tokens are stored only as SHA-256 hashes.
  oauthClients: defineTable({
    clientId: v.string(),
    clientName: v.string(),
    redirectUris: v.array(v.string()),
    createdAt: v.number(),
  }).index("by_clientId", ["clientId"]),
  // One approval on the sign-in page. Revoking it revokes every token issued
  // under it. lastUsedAt is updated at most once a minute.
  oauthGrants: defineTable({
    clientId: v.string(),
    clientName: v.string(),
    redirectHost: v.string(),
    // SHA-256 of `${ownerKeySalt}:${OWNER_ACCESS_TOKEN}` when the grant was
    // approved. Rotating the owner key makes every older grant stop working
    // (see isGrantCurrent). Grants from before this field are refused.
    ownerKeySalt: v.optional(v.string()),
    ownerKeyFingerprint: v.optional(v.string()),
    createdAt: v.number(),
    lastUsedAt: v.union(v.number(), v.null()),
    revokedAt: v.union(v.number(), v.null()),
  }).index("by_revokedAt", ["revokedAt"]),
  oauthCodes: defineTable({
    codeHash: v.string(),
    grantId: v.id("oauthGrants"),
    clientId: v.string(),
    clientName: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    resource: v.union(v.string(), v.null()),
    expiresAt: v.number(),
    createdAt: v.number(),
    lastUsedAt: v.union(v.number(), v.null()),
    revokedAt: v.union(v.number(), v.null()),
  }).index("by_codeHash", ["codeHash"]),
  oauthTokens: defineTable({
    tokenHash: v.string(),
    kind: v.union(v.literal("access"), v.literal("refresh")),
    grantId: v.id("oauthGrants"),
    clientId: v.string(),
    clientName: v.string(),
    resource: v.union(v.string(), v.null()),
    expiresAt: v.number(),
    createdAt: v.number(),
    lastUsedAt: v.union(v.number(), v.null()),
    revokedAt: v.union(v.number(), v.null()),
  })
    .index("by_tokenHash", ["tokenHash"])
    .index("by_grantId", ["grantId"]),

  authThrottle: defineTable({
    key: v.string(),
    failedCount: v.number(),
    lockedUntil: v.union(v.number(), v.null()),
    updatedAt: v.number(),
  }).index("by_key", ["key"]),

  nodeSymbolCaches: defineTable({
    nodeId: v.id("nodes"),
    contentHash: v.string(),
    sourceText: v.string(),
    symbols: v.string(),
    style: v.optional(v.string()),
    model: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_node", ["nodeId"])
    .index("by_content_hash", ["contentHash"]),

  // Writes the guards would refuse or change (convex/lib/guards.ts).
  guardViolations: defineTable({
    mutation: v.string(),
    guard: v.string(),
    mode: v.string(),
    nodeId: v.optional(v.string()),
    pageId: v.optional(v.string()),
    detail: v.string(),
    createdAt: v.number(),
  }).index("by_createdAt", ["createdAt"]),
  // Stored undo receipts for completions (Phase 4). A receipt holds what the
  // action changed (before-states, created and archived subtrees) plus the
  // checks undo and redo run first: the revision each touched item should be
  // at, and the members of each subtree they would delete or restore.
  // See convex/lib/undoReceipts.ts.
  undoReceipts: defineTable({
    action: v.union(v.literal("completion"), v.literal("forceArchive")),
    targetNodeId: v.id("nodes"),
    completionMode: v.union(v.literal("dueDate"), v.literal("today")),
    plannerPageId: v.optional(v.id("pages")),
    // What the completion asked for; redo replays it. Unset on receipts from
    // before it was stored, which were all "complete".
    intent: v.optional(v.union(v.literal("complete"), v.literal("reopen"))),
    // "applied": undo is next; "undone": redo is next.
    state: v.union(v.literal("applied"), v.literal("undone")),
    // PlannerCompletionReceipt (lib/domain/planner.ts).
    receipt: v.any(),
    // Revisions the current state left (checked before undo or redo), and the
    // revisions just before the last transition (used to chain receipts).
    expect: v.array(v.object({ nodeId: v.id("nodes"), revision: v.number(), text: v.string() })),
    prev: v.array(v.object({ nodeId: v.id("nodes"), revision: v.number() })),
    subtrees: v.array(
      v.object({
        role: v.union(v.literal("delete"), v.literal("restore")),
        rootNodeId: v.id("nodes"),
        nodeIds: v.array(v.id("nodes")),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_state_and_updatedAt", ["state", "updatedAt"]),
});
