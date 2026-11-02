import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKeyGuarded } from "./lib/authThrottle";
import {
  computeNodePosition,
  deleteNodeTree,
  enqueueNodeAiWork,
  syncLinksForNode,
} from "./lib/workspace";
import { withGuards } from "./lib/guards";

export const ensureChatThread = mutation({
  args: {
    ownerKey: v.string(),
    pageId: v.optional(v.id("pages")),
  },
  handler: async (rawCtx, args) => {
    const ctx = withGuards(rawCtx, "chatData:ensureChatThread");
    await assertOwnerKeyGuarded(ctx.db, args.ownerKey);
    const existing = args.pageId
      ? await ctx.db
          .query("chatThreads")
          .withIndex("by_page_updatedAt", (query) =>
            query.eq("pageId", args.pageId!),
          )
          .order("desc")
          .first()
      : await ctx.db
          .query("chatThreads")
          .withIndex("by_updatedAt")
          .order("desc")
          .first();

    if (existing) {
      return existing._id;
    }

    const now = Date.now();
    return await ctx.db.insert("chatThreads", {
      pageId: args.pageId ?? null,
      title: args.pageId ? "Page Chat" : "Workspace Chat",
      createdAt: now,
      updatedAt: now,
    });
  },
});

export const getChatThread = query({
  args: {
    ownerKey: v.string(),
    threadId: v.optional(v.id("chatThreads")),
    pageId: v.optional(v.id("pages")),
  },
  handler: async (ctx, args) => {
    await assertOwnerKeyGuarded(ctx.db, args.ownerKey);

    const thread = args.threadId
      ? await ctx.db.get(args.threadId)
      : args.pageId
        ? await ctx.db
            .query("chatThreads")
            .withIndex("by_page_updatedAt", (query) =>
              query.eq("pageId", args.pageId!),
            )
            .order("desc")
            .first()
        : await ctx.db
            .query("chatThreads")
            .withIndex("by_updatedAt")
            .order("desc")
            .first();

    if (!thread) {
      return null;
    }

    const messages = await ctx.db
      .query("chatMessages")
      .withIndex("by_thread_createdAt", (query) =>
        query.eq("threadId", thread._id),
      )
      .collect();

    return {
      thread,
      messages,
    };
  },
});

export const getThreadMessages = internalQuery({
  args: {
    threadId: v.id("chatThreads"),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const query = ctx.db
      .query("chatMessages")
      .withIndex("by_thread_createdAt", (query) =>
        query.eq("threadId", args.threadId),
      );

    if (args.limit && args.limit > 0) {
      const recentMessages = await query
        .order("desc")
        .take(Math.max(1, Math.floor(args.limit)));
      return recentMessages.reverse();
    }

    return await query.collect();
  },
});

export const storeUserMessage = internalMutation({
  args: {
    threadId: v.id("chatThreads"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.threadId, {
      updatedAt: now,
    });
    return await ctx.db.insert("chatMessages", {
      threadId: args.threadId,
      role: "user",
      text: args.text,
      status: "ready",
      createdAt: now,
    });
  },
});

export const storeAssistantMessage = internalMutation({
  args: {
    threadId: v.id("chatThreads"),
    text: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.threadId, {
      updatedAt: now,
    });
    return await ctx.db.insert("chatMessages", {
      threadId: args.threadId,
      role: "assistant",
      text: args.text,
      metadata: args.metadata,
      status: "ready",
      createdAt: now,
    });
  },
});

export const replaceSectionLines = internalMutation({
  args: {
    pageId: v.id("pages"),
    sectionNodeId: v.id("nodes"),
    lines: v.array(v.string()),
    generatedFrom: v.optional(v.string()),
  },
  handler: async (rawCtx, args) => {
    const ctx = withGuards(rawCtx, "chatData:replaceSectionLines");
    const normalizedLines = args.lines
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const lockKind = args.generatedFrom === "journal_feedback";

    const existingChildren = await ctx.db
      .query("nodes")
      .withIndex("by_page_parent_position", (query) =>
        query.eq("pageId", args.pageId).eq("parentNodeId", args.sectionNodeId),
      )
      .collect();

    for (const child of existingChildren) {
      await deleteNodeTree(ctx.db, child._id);
    }

    let lastNodeId: Id<"nodes"> | null = null;
    let insertedCount = 0;

    for (const line of normalizedLines) {
      const nodeId: Id<"nodes"> = await ctx.db.insert("nodes", {
        pageId: args.pageId,
        parentNodeId: args.sectionNodeId,
        position: await computeNodePosition(
          ctx.db,
          args.pageId,
          args.sectionNodeId,
          lastNodeId,
        ),
        text: line,
        kind: "note",
        taskStatus: null,
        priority: null,
        dueAt: null,
        archived: false,
        sourceMeta: {
          sourceType: "chat",
          generatedFrom: args.generatedFrom ?? "chat_section",
          ...(lockKind ? { taskKindLocked: true } : {}),
        },
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });

      lastNodeId = nodeId;
      insertedCount += 1;

      const inserted = (await ctx.db.get(nodeId)) as Doc<"nodes"> | null;
      if (inserted) {
        await syncLinksForNode(ctx.db, inserted);
        await enqueueNodeAiWork(ctx, inserted._id);
      }
    }

    await ctx.db.patch(args.sectionNodeId, {
      updatedAt: Date.now(),
    });

    return {
      insertedCount,
    };
  },
});
