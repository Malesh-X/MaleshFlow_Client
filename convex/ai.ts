"use node";

import { createHash } from "node:crypto";
import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { v } from "convex/values";
import { z } from "zod";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { assertOwnerKeyGuardedInAction } from "./lib/authThrottle";
import {
  buildDeterministicEmbedding,
  buildEmbeddingInput,
  buildRootEmbeddingInput,
  shouldGenerateEmbeddingForNodeText,
} from "../lib/domain/embeddings";
import {
  normalizeScreenshotImportNodes,
  screenshotImportResultSchema,
} from "../lib/domain/screenshotImport";
import { isSeparatorLineText } from "../lib/domain/displaySyntax";

const taskMetadataSchema = z.object({
  kind: z.enum(["note", "task"]),
  taskStatus: z.enum(["todo", "in_progress", "done", "cancelled"]).nullable(),
  priority: z.enum(["low", "medium", "high"]).nullable(),
  rationale: z.string(),
});

const screenshotImportOutputSchema = screenshotImportResultSchema;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fallbackTextSearchRef = internal.aiData.fallbackTextSearch as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const hydrateEmbeddingMatchesRef = internal.aiData.hydrateEmbeddingMatches as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getNodeEmbeddingContextRef = internal.workspace.getNodeEmbeddingContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getNodeTaskMetadataContextRef = internal.workspace.getNodeTaskMetadataContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const upsertEmbeddingJobRef = internal.aiData.upsertEmbeddingJob as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getEmbeddingJobStateRef = internal.aiData.getEmbeddingJobState as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const saveNodeEmbeddingRef = internal.aiData.saveNodeEmbedding as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const clearNodeEmbeddingRef = internal.aiData.clearNodeEmbedding as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const applyTaskMetadataRef = internal.aiData.applyTaskMetadata as any;

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

async function createEmbedding(text: string) {
  const client = getOpenAIClient();
  if (!client) {
    return buildDeterministicEmbedding(text);
  }

  const response = await client.embeddings.create({
    model: process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small",
    input: text,
  });

  return response.data[0]?.embedding ?? buildDeterministicEmbedding(text);
}

function buildEmbeddingContentHash(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function runSemanticSearch(ctx: any, args: {
  query: string;
  pageId?: string;
  limit?: number;
  includeArchived?: boolean;
}) {
  const limit = Math.max(1, Math.min(args.limit ?? 8, 20));
  const vector = await createEmbedding(args.query);

  const matches = await ctx.vectorSearch("nodeEmbeddings", "by_embedding", {
    vector,
    limit,
    filter: args.pageId
      ? (query: { eq: (field: string, value: unknown) => unknown }) =>
          query.eq("pageId", args.pageId!)
      : undefined,
  });

  if (matches.length === 0) {
    return await ctx.runQuery(fallbackTextSearchRef, {
      query: args.query,
      pageId: args.pageId ?? undefined,
      limit,
      includeArchived: args.includeArchived ?? false,
    });
  }

  return await ctx.runQuery(hydrateEmbeddingMatchesRef, {
    embeddingIds: matches.map((match: { _id: string }) => match._id),
    includeArchived: args.includeArchived ?? false,
  });
}

export const searchNodes = action({
  args: {
    ownerKey: v.string(),
    query: v.string(),
    pageId: v.optional(v.id("pages")),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<unknown[]> => {
    await assertOwnerKeyGuardedInAction(ctx, args.ownerKey);
    return await runSemanticSearch(ctx, {
      query: args.query,
      pageId: args.pageId as string | undefined,
      limit: args.limit,
      includeArchived: false,
    });
  },
});

export const findNodesText = action({
  args: {
    ownerKey: v.string(),
    query: v.string(),
    pageId: v.optional(v.id("pages")),
    limit: v.optional(v.number()),
    exact: v.optional(v.boolean()),
  },
  handler: async (ctx, args): Promise<unknown[]> => {
    await assertOwnerKeyGuardedInAction(ctx, args.ownerKey);
    return await ctx.runQuery(fallbackTextSearchRef, {
      query: args.query,
      pageId: args.pageId,
      limit: Math.max(1, Math.min(args.limit ?? 12, 20)),
      includeArchived: false,
      exact: args.exact,
    });
  },
});

export const searchArchivedNodes = action({
  args: {
    ownerKey: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<unknown[]> => {
    await assertOwnerKeyGuardedInAction(ctx, args.ownerKey);
    return await runSemanticSearch(ctx, {
      query: args.query,
      limit: args.limit,
      includeArchived: true,
    });
  },
});

export const findArchivedNodesText = action({
  args: {
    ownerKey: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args): Promise<unknown[]> => {
    await assertOwnerKeyGuardedInAction(ctx, args.ownerKey);
    return await ctx.runQuery(fallbackTextSearchRef, {
      query: args.query,
      limit: Math.max(1, Math.min(args.limit ?? 12, 20)),
      includeArchived: true,
    });
  },
});

export const parseOutlineScreenshot = action({
  args: {
    ownerKey: v.string(),
    imageDataUrl: v.string(),
  },
  handler: async (ctx, args): Promise<unknown> => {
    await assertOwnerKeyGuardedInAction(ctx, args.ownerKey);
    const client = getOpenAIClient();
    if (!client) {
      throw new Error("Screenshot import requires an OpenAI API key.");
    }

    const response = await client.responses.parse({
      model: process.env.OPENAI_VISION_MODEL ?? "gpt-4.1-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text:
                "You convert screenshots of outliner apps into structured outline nodes. " +
                "Return only what is visibly present in the screenshot. Preserve nesting/order. " +
                "Rows with visible checkboxes are tasks. Checked boxes are done; unchecked boxes are todo. " +
                "Rows with regular bullets are notes. If a note row is visually prominent like a section heading, " +
                "encode it as a note whose text starts with '### '. " +
                "Preserve visible inline emphasis using '__double underscores__' for italics and '**double asterisks**' for bold. " +
                "Ignore app chrome like counters, arrows, drag rails, and badges that are not part of the content text. " +
                "Keep inline chip/pill text as plain text when it is clearly content.",
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "Parse this screenshot into outline nodes for import. " +
                "The large bold bullet rows should usually become '###' note headings.",
            },
            {
              type: "input_image",
              image_url: args.imageDataUrl,
              detail: "high",
            },
          ],
        },
      ],
      text: {
        format: zodTextFormat(screenshotImportOutputSchema, "outline_screenshot_import"),
      },
    });

    const parsed = response.output_parsed;
    if (!parsed) {
      throw new Error("Could not parse the screenshot into outline nodes.");
    }

    return {
      summary: parsed.summary,
      warnings: parsed.warnings,
      nodes: normalizeScreenshotImportNodes(parsed.nodes),
    };
  },
});

export const generateEmbeddingForNode = internalAction({
  args: {
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    try {
      const context = await ctx.runQuery(getNodeEmbeddingContextRef, {
        nodeId: args.nodeId,
      });

      if (!context || context.node.archived) {
        await ctx.runMutation(clearNodeEmbeddingRef, {
          nodeId: args.nodeId,
        });
        return;
      }

      if (!shouldGenerateEmbeddingForNodeText(context.node.text)) {
        await ctx.runMutation(clearNodeEmbeddingRef, {
          nodeId: args.nodeId,
        });
        return;
      }

      const input =
        context.node.parentNodeId === null
          ? buildRootEmbeddingInput({
              pageTitle: context.pageTitle,
              rootText: context.node.text.trim(),
              subtreeLines: context.subtreeLines ?? [],
            })
          : buildEmbeddingInput({
              pageTitle: context.pageTitle,
              ancestors: context.ancestors,
              nodeText: context.node.text,
            });

      if (input.trim().length === 0) {
        await ctx.runMutation(clearNodeEmbeddingRef, {
          nodeId: args.nodeId,
        });
        return;
      }

      const contentHash = buildEmbeddingContentHash(input);
      const existingJob = await ctx.runQuery(getEmbeddingJobStateRef, {
        nodeId: args.nodeId,
      });
      const activeRebuildRunId =
        existingJob?.status === "queued" ? existingJob.rebuildRunId ?? undefined : undefined;

      if (
        existingJob?.lastEmbeddedHash === contentHash &&
        existingJob?.lastEmbeddedPageId === context.node.pageId
      ) {
        await ctx.runMutation(upsertEmbeddingJobRef, {
          nodeId: args.nodeId,
          status: "completed",
          rebuildRunId: activeRebuildRunId,
        });
        return;
      }

      await ctx.runMutation(upsertEmbeddingJobRef, {
        nodeId: args.nodeId,
        status: "running",
        rebuildRunId: activeRebuildRunId,
      });

      const vector = await createEmbedding(input);

      await ctx.runMutation(saveNodeEmbeddingRef, {
        nodeId: context.node._id,
        pageId: context.node.pageId,
        content: input,
        contentHash,
        vector,
      });
    } catch (error) {
      const existingJob = await ctx.runQuery(getEmbeddingJobStateRef, {
        nodeId: args.nodeId,
      });
      await ctx.runMutation(upsertEmbeddingJobRef, {
        nodeId: args.nodeId,
        status: "error",
        error: error instanceof Error ? error.message : "Embedding generation failed.",
        rebuildRunId: existingJob?.rebuildRunId ?? undefined,
      });
    }
  },
});

function inferTaskMetadataHeuristically(text: string, existingKind: "note" | "task") {
  if (isSeparatorLineText(text)) {
    return {
      kind: "note",
      taskStatus: null,
      priority: null,
    } as const;
  }

  const lowered = text.toLowerCase();
  const likelyTask =
    existingKind === "task" ||
    /^(todo|fix|ship|draft|buy|email|call|review|plan|follow up)\b/.test(lowered) ||
    /\b(todo|follow up|next step|action item)\b/.test(lowered);

  return {
    kind: likelyTask ? "task" : "note",
    taskStatus: likelyTask ? "todo" : null,
    priority: /\b(urgent|asap|critical)\b/.test(lowered) ? "high" : null,
  } as const;
}

export const extractTaskMetadata = internalAction({
  args: {
    nodeId: v.id("nodes"),
  },
  handler: async (ctx, args) => {
    const context = await ctx.runQuery(getNodeTaskMetadataContextRef, {
      nodeId: args.nodeId,
    });

    if (!context || context.node.archived || context.node.text.trim().length === 0) {
      return;
    }

    const sourceMeta =
      context.node.sourceMeta && typeof context.node.sourceMeta === "object"
        ? (context.node.sourceMeta as Record<string, unknown>)
        : {};

    if (sourceMeta.taskKindLocked === true) {
      return;
    }

    if (isSeparatorLineText(context.node.text)) {
      await ctx.runMutation(applyTaskMetadataRef, {
        nodeId: context.node._id,
        kind: "note",
        taskStatus: null,
        priority: null,
      });
      return;
    }

    if (context.node.kind === "task") {
      await ctx.runMutation(applyTaskMetadataRef, {
        nodeId: context.node._id,
        kind: "task",
        taskStatus: context.node.taskStatus ?? "todo",
        priority: context.node.priority ?? null,
      });
      return;
    }

    const client = getOpenAIClient();
    if (!client) {
      const heuristic = inferTaskMetadataHeuristically(
        context.node.text,
        context.node.kind,
      );
      await ctx.runMutation(applyTaskMetadataRef, {
        nodeId: context.node._id,
        kind: heuristic.kind,
        taskStatus: heuristic.taskStatus,
        priority: heuristic.priority,
      });
      return;
    }

    try {
      const response = await client.responses.parse({
        model: process.env.OPENAI_TASK_MODEL ?? "gpt-5-mini",
        input: [
          {
            role: "system",
            content:
              "Classify whether an outline node is a task or a note. Prefer keeping ambiguous content as a note. Only mark obvious action items as tasks.",
          },
          {
            role: "user",
            content: `Page: ${context.pageTitle}\nAncestors: ${context.ancestors.join(" > ") || "(none)"}\nNode: ${context.node.text}\nCurrent kind: ${context.node.kind}`,
          },
        ],
        text: {
          format: zodTextFormat(taskMetadataSchema, "task_metadata"),
        },
      });

      const parsed = response.output_parsed ?? inferTaskMetadataHeuristically(context.node.text, context.node.kind);
      await ctx.runMutation(applyTaskMetadataRef, {
        nodeId: context.node._id,
        kind: parsed.kind,
        taskStatus: parsed.kind === "task" ? (parsed.taskStatus ?? "todo") : null,
        priority: parsed.priority,
      });
    } catch {
      const heuristic = inferTaskMetadataHeuristically(
        context.node.text,
        context.node.kind,
      );
      await ctx.runMutation(applyTaskMetadataRef, {
        nodeId: context.node._id,
        kind: heuristic.kind,
        taskStatus: heuristic.taskStatus,
        priority: heuristic.priority,
      });
    }
  },
});
