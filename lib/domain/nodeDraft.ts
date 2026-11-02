// The app's draft syntax for one item's text, shared by the app's editor and
// composer and the server's `parseDraft` option (Phase 3, change 6):
// - empty text (or only "%%") means "no item" (shouldDelete);
// - "[ ] text" is an open task, "[x] text" a done task;
// - a leading "%%" (dimmed) is kept on the text;
// - "---" is a separator note;
// - anything else keeps the fallback kind and status.
import { isSeparatorLineText } from "./displaySyntax";

export type DraftTaskStatus = "todo" | "in_progress" | "done" | "cancelled";

export type ParsedNodeDraft =
  | { shouldDelete: true }
  | {
      shouldDelete: false;
      text: string;
      kind: "note" | "task";
      taskStatus: DraftTaskStatus | null;
    };

export function parseNodeDraftWithFallback(
  draft: string,
  fallback: {
    kind: "note" | "task";
    taskStatus: DraftTaskStatus | null;
  },
): ParsedNodeDraft {
  const trimmed = draft.trim();
  if (trimmed.length === 0) {
    return { shouldDelete: true };
  }

  const dimPrefix = trimmed.match(/^%%\s*/)?.[0] ?? "";
  const content = dimPrefix ? trimmed.slice(dimPrefix.length) : trimmed;
  if (content.trim().length === 0) {
    return { shouldDelete: true };
  }

  const doneMatch = content.match(/^\[x\]\s*(.*)$/i);
  if (doneMatch) {
    const text = doneMatch[1]?.trim() ?? "";
    return text.length === 0
      ? { shouldDelete: true }
      : { shouldDelete: false, text: `${dimPrefix}${text}`, kind: "task", taskStatus: "done" };
  }

  const todoMatch = content.match(/^\[\s\]\s*(.*)$/);
  if (todoMatch) {
    const text = todoMatch[1]?.trim() ?? "";
    return text.length === 0
      ? { shouldDelete: true }
      : { shouldDelete: false, text: `${dimPrefix}${text}`, kind: "task", taskStatus: "todo" };
  }

  if (isSeparatorLineText(content)) {
    return { shouldDelete: false, text: trimmed, kind: "note", taskStatus: null };
  }

  return {
    shouldDelete: false,
    text: trimmed,
    kind: fallback.kind,
    taskStatus: fallback.kind === "task" ? (fallback.taskStatus ?? "todo") : null,
  };
}

// A plain line with no fallback kind is a note.
export function parseNodeDraft(draft: string): ParsedNodeDraft {
  return parseNodeDraftWithFallback(draft, { kind: "note", taskStatus: null });
}
