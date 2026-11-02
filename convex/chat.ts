"use node";

import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { v } from "convex/values";
import { z } from "zod";
import { action } from "./_generated/server";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { assertOwnerKeyGuardedInAction } from "./lib/authThrottle";
import {
  buildJournalFeedbackUserPrompt,
  buildModelRewriteUserPrompt,
  JOURNAL_FEEDBACK_SYSTEM_PROMPT,
  MODEL_REWRITE_SYSTEM_PROMPT,
} from "../lib/domain/aiPrompts";

const modelRewriteSchema = z.object({
  summary: z.string(),
  modelLines: z.array(z.string()).min(1).max(24),
});

const journalFeedbackSchema = z.object({
  summary: z.string(),
  feedbackLines: z.array(z.string()).min(1).max(24),
});

type ModelRewriteDebug = {
  model: string;
  systemPrompt: string;
  userPrompt: string;
  response:
    | {
        summary: string;
        modelLines: string[];
      }
    | null;
  error: string | null;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ensureChatThreadRef = api.chatData.ensureChatThread as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeUserMessageRef = internal.chatData.storeUserMessage as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getThreadMessagesRef = internal.chatData.getThreadMessages as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const storeAssistantMessageRef = internal.chatData.storeAssistantMessage as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const replaceSectionLinesRef = internal.chatData.replaceSectionLines as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getModelPageContextRef = internal.workspace.getModelPageContext as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getJournalPageContextRef = internal.workspace.getJournalPageContext as any;
const getResolvedLinkedTargetsForNodesRef =
  internal.workspace.getResolvedLinkedTargetsForNodes as any; // eslint-disable-line @typescript-eslint/no-explicit-any
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getLinkedKnowledgeContextRef = internal.workspace.getLinkedKnowledgeContext as any;

const RECENT_CHAT_CONTEXT_MESSAGE_COUNT = 4;

function buildAiRequestPreview(args: {
  systemPrompt: string;
  userPrompt: string;
}) {
  return `System:\n${args.systemPrompt}\n\nUser:\n${args.userPrompt}`;
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
}

async function buildExplicitLinkedContextForNodes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ctx: any,
  nodeIds: Id<"nodes">[],
) {
  const uniqueNodeIds = [...new Set(nodeIds)];
  if (uniqueNodeIds.length === 0) {
    return "";
  }

  const linkedTargets = (await ctx.runQuery(getResolvedLinkedTargetsForNodesRef, {
    nodeIds: uniqueNodeIds,
  })) as {
    pageIds: Id<"pages">[];
    nodeIds: Id<"nodes">[];
  };

  if (linkedTargets.pageIds.length === 0 && linkedTargets.nodeIds.length === 0) {
    return "";
  }

  const linkedContext = (await ctx.runQuery(getLinkedKnowledgeContextRef, {
    pageIds: linkedTargets.pageIds,
    nodeIds: linkedTargets.nodeIds,
  })) as {
    pages: Array<{
      page: Doc<"pages">;
      representativeNode: Doc<"nodes"> | null;
      content: string;
    }>;
    nodes: Array<{
      node: Doc<"nodes">;
      page: Doc<"pages">;
      content: string;
    }>;
  };

  return [
    ...linkedContext.pages
      .filter((entry) => entry.content.trim().length > 0)
      .map((entry, index) =>
        [
          `Linked page [${index + 1}]: ${entry.page.title}`,
          entry.content,
        ].join("\n"),
      ),
    ...linkedContext.nodes.map((entry, index) =>
      [
        `Linked node [N${index + 1}] on ${entry.page.title}`,
        entry.content.trim().length > 0 ? entry.content : entry.node.text || "(empty line)",
      ].join("\n"),
    ),
  ].join("\n\n");
}

export const rewriteModelSection = action({
  args: {
    ownerKey: v.string(),
    prompt: v.string(),
    pageId: v.id("pages"),
    threadId: v.optional(v.id("chatThreads")),
    userNote: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    threadId: Id<"chatThreads">;
    messageId: Id<"chatMessages">;
    summary: string;
    modelLines: string[];
    debug: ModelRewriteDebug;
  }> => {
    await assertOwnerKeyGuardedInAction(ctx, args.ownerKey);

    const threadId: Id<"chatThreads"> =
      args.threadId ??
      (await ctx.runMutation(ensureChatThreadRef, {
        ownerKey: args.ownerKey,
        pageId: args.pageId,
      }));

    await ctx.runMutation(storeUserMessageRef, {
      threadId,
      text:
        args.userNote && args.userNote.trim().length > 0
          ? `${args.userNote.trim()}\n\n${args.prompt}`
          : args.prompt,
    });

    const modelContext = await ctx.runQuery(getModelPageContextRef, {
      pageId: args.pageId,
    });
    if (!modelContext?.modelSection) {
      throw new Error("Model section not found for this page.");
    }

    const priorMessages = await ctx.runQuery(getThreadMessagesRef, {
      threadId,
      limit: RECENT_CHAT_CONTEXT_MESSAGE_COUNT + 1,
    });

    const existingModelLines = modelContext.modelLines.map(
      (node: { text: string }) => node.text,
    );
    const recentExampleLines = modelContext.recentExampleLines.map(
      (node: { text: string }) => node.text,
    );
    const explicitLinkedContext = await buildExplicitLinkedContextForNodes(
      ctx,
      [
        ...modelContext.modelLines.map((node: { _id: Id<"nodes"> }) => node._id),
        ...modelContext.recentExampleLines.map((node: { _id: Id<"nodes"> }) => node._id),
      ],
    );

    const fallbackModelLines =
      existingModelLines.length > 0
        ? existingModelLines
        : [args.prompt.trim()];

    let summary = "Updated the model section.";
    let modelLines = fallbackModelLines;
    let shouldApplyModelLines = false;
    const model = process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini";
    const systemPrompt = MODEL_REWRITE_SYSTEM_PROMPT;
    const userPrompt = buildModelRewriteUserPrompt({
      pageTitle: modelContext.page.title,
      request: args.prompt,
      userNote: args.userNote,
      existingModelLines,
      recentExampleLines,
      explicitLinkedContext,
      recentConversationLines: priorMessages
        .slice(0, -1)
        .map((message: { role: string; text: string }) => `${message.role}: ${message.text}`),
    });
    const debug: ModelRewriteDebug = {
      model,
      systemPrompt,
      userPrompt,
      response: null,
      error: null,
    };

    const client = getOpenAIClient();
    if (!client) {
      summary = "OpenAI is not configured, so the model section was left unchanged.";
      debug.error = "OPENAI_API_KEY is not configured in Convex.";
    } else {
      try {
        const response = await client.responses.parse({
          model,
          input: [
            {
              role: "system",
              content: systemPrompt,
            },
            {
              role: "user",
              content: userPrompt,
            },
          ],
          text: {
            format: zodTextFormat(modelRewriteSchema, "model_section_rewrite"),
          },
        });

        const parsed = response.output_parsed;
        if (parsed) {
          summary = parsed.summary;
          modelLines = parsed.modelLines
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
          shouldApplyModelLines = modelLines.length > 0;
          debug.response = {
            summary: parsed.summary,
            modelLines,
          };
        }
      } catch (error) {
        summary =
          error instanceof Error
            ? `OpenAI rewrite failed: ${error.message}`
            : "OpenAI could not rewrite the model section, so it was left unchanged.";
        debug.error = error instanceof Error ? error.message : "Unknown OpenAI error.";
      }
    }

    if (shouldApplyModelLines && modelLines.length > 0) {
      await ctx.runMutation(replaceSectionLinesRef, {
        pageId: args.pageId,
        sectionNodeId: modelContext.modelSection._id,
        lines: modelLines,
        generatedFrom: "model_chat",
      });
    }

    const messageId: Id<"chatMessages"> = await ctx.runMutation(
      storeAssistantMessageRef,
      {
        threadId,
        text: summary,
        metadata: {
          request: buildAiRequestPreview({
            systemPrompt,
            userPrompt,
          }),
        },
      },
    );

    return {
      threadId,
      messageId,
      summary,
      modelLines,
      debug,
    };
  },
});

export const generateJournalFeedback = action({
  args: {
    ownerKey: v.string(),
    pageId: v.id("pages"),
    userNote: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{
    summary: string;
    feedbackLines: string[];
  }> => {
    await assertOwnerKeyGuardedInAction(ctx, args.ownerKey);

    const journalContext = await ctx.runQuery(getJournalPageContextRef, {
      pageId: args.pageId,
    });
    if (!journalContext?.thoughtsSection || !journalContext.feedbackSection) {
      throw new Error("Journal sections were not found for this page.");
    }

    const whatHappenedLines = journalContext.whatHappenedLines.map(
      (node: { text: string }) => node.text.trim(),
    ).filter((line: string) => line.length > 0);
    const thoughtLines = journalContext.thoughtLines.map(
      (node: { text: string }) => node.text.trim(),
    ).filter((line: string) => line.length > 0);
    const explicitLinkedContext = await buildExplicitLinkedContextForNodes(
      ctx,
      [
        ...journalContext.whatHappenedLines,
        ...journalContext.thoughtLines,
      ].map((node: { _id: Id<"nodes"> }) => node._id),
    );

    if (whatHappenedLines.length === 0 && thoughtLines.length === 0) {
      return {
        summary: "Add what happened or some thoughts first, then generate feedback.",
        feedbackLines: [],
      };
    }

    const client = getOpenAIClient();
    if (!client) {
      return {
        summary: "OpenAI is not configured, so the Feedback section was left unchanged.",
        feedbackLines: [],
      };
    }

    try {
      const response = await client.responses.parse({
        model: process.env.OPENAI_CHAT_MODEL ?? "gpt-5-mini",
        input: [
          {
            role: "system",
            content: JOURNAL_FEEDBACK_SYSTEM_PROMPT,
          },
          {
            role: "user",
            content: buildJournalFeedbackUserPrompt({
              pageTitle: journalContext.page.title,
              userNote: args.userNote,
              whatHappenedLines,
              thoughtLines,
              explicitLinkedContext,
            }),
          },
        ],
        text: {
          format: zodTextFormat(journalFeedbackSchema, "journal_feedback"),
        },
      });

      const parsed = response.output_parsed;
      if (!parsed) {
        return {
          summary: "OpenAI returned no feedback, so the Feedback section was left unchanged.",
          feedbackLines: [],
        };
      }

      const feedbackLines = parsed.feedbackLines
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      if (feedbackLines.length === 0) {
        return {
          summary: parsed.summary,
          feedbackLines: [],
        };
      }

      await ctx.runMutation(replaceSectionLinesRef, {
        pageId: args.pageId,
        sectionNodeId: journalContext.feedbackSection._id,
        lines: feedbackLines,
        generatedFrom: "journal_feedback",
      });

      return {
        summary: parsed.summary,
        feedbackLines,
      };
    } catch (error) {
      return {
        summary:
          error instanceof Error
            ? `OpenAI feedback failed: ${error.message}`
            : "OpenAI could not generate feedback, so the Feedback section was left unchanged.",
        feedbackLines: [],
      };
    }
  },
});
