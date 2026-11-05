// Pure write rules shared by the server guards (convex/lib/guards.ts).
// No Convex imports, so they run in plain unit tests.
// See Phase 2 of docs/server-logic-plan.md.

import { isNodeLocked } from "../../lib/domain/workspaceRules";

export type GuardMode = "record" | "enforce";

// "record": a violation is logged to the guardViolations table and the write
// goes ahead unchanged. "enforce": the write throws a guardRefused ConvexError
// (or, for schedules, is normalized) and the caller logs the refusal.
// Enforced since 2026-11-05, after Nov 2-5 in record mode logged no violations.
export const GUARD_MODE: GuardMode = "enforce";

// Mutations only old browser tabs call: the current app, CLI and MCP server
// use none of them (tests/guardCoverage.test.ts checks). Old bundles can't
// show or report a refusal, so these keep logging instead of refusing until
// they are retired (docs/deploying.md).
export const LEGACY_RECORD_ONLY_MUTATIONS: ReadonlySet<string> = new Set([
  "workspace:createNode",
  "workspace:reorderNode",
  "workspace:moveNodeTreesToPage",
  "workspace:archiveNode",
  "workspace:deleteNode",
  "workspace:completeTaskPageTask",
  "planner:setPlannerStartDate",
  "planner:addRandomPlannerTask",
  "planner:addPlannerSourceTask",
  "planner:reorderPlannerDay",
  "planner:reorderPlannerFocusSection",
  "planner:resolveNextPlannerTask",
  "planner:completePlannerTask",
  "planner:completePlannerSourceTask",
]);

// GUARD_MODE, unless the deployment's GUARD_MODE_OVERRIDE env var says
// "record" or "enforce". The override is the switch back without a deploy:
// `npx convex env set GUARD_MODE_OVERRIDE record --prod`.
export function currentGuardMode(): GuardMode {
  const override = typeof process === "undefined" ? undefined : process.env.GUARD_MODE_OVERRIDE;
  return override === "record" || override === "enforce" ? override : GUARD_MODE;
}

// The mode a mutation's guards run in.
export function guardModeFor(mutation: string, mode: GuardMode = currentGuardMode()): GuardMode {
  return LEGACY_RECORD_ONLY_MUTATIONS.has(mutation) ? "record" : mode;
}

export const GUARD_NAMES = ["assertNodeEditable", "assertValidParent", "assertPageWritable", "normalizeSchedule"] as const;
export type GuardName = (typeof GUARD_NAMES)[number];

// What a write does to an existing node. Locked items (section headers,
// planner days) may still be renamed or have other fields set.
// "dataDump" (excluding from or including in data dumps) is a privacy flag,
// so it is allowed on archived pages too.
export type NodeChange = "move" | "archive" | "unarchive" | "delete" | "kind" | "status" | "text" | "schedule" | "dataDump" | "other";
const LOCK_PROTECTED: ReadonlySet<NodeChange> = new Set(["move", "archive", "unarchive", "delete", "kind", "status"]);

type MetaHolder = { sourceMeta?: unknown } | null | undefined;
const metaOf = (value: MetaHolder): Record<string, unknown> =>
  value && typeof value.sourceMeta === "object" && value.sourceMeta ? (value.sourceMeta as Record<string, unknown>) : {};

// Section headers and planner days (shared with the app and CLI).
export const isLockedNode = isNodeLocked;

export type PageLike = { archived: boolean; sourceMeta?: unknown } | null | undefined;

export function pageWriteProblem(page: PageLike, options: { allowArchived?: boolean } = {}) {
  if (!page) return "Page not found.";
  if (metaOf(page).deletingForever === true) return "That page is being deleted.";
  if (page.archived && !options.allowArchived) return "That page is archived. Restore it before editing.";
  return null;
}

export function nodeEditProblem(args: { node: (MetaHolder & { archived?: boolean }) | null; page: PageLike; change: NodeChange }) {
  const { node, page, change } = args;
  if (!node) return "Item not found.";
  const pageProblem = pageWriteProblem(page, { allowArchived: change === "dataDump" });
  if (pageProblem) return pageProblem;
  if (LOCK_PROTECTED.has(change) && isLockedNode(node)) {
    return `Section headers and planner days can't be changed that way (${change}).`;
  }
  return null;
}

export type ParentLike = { _id: string; pageId: string; archived: boolean } | null;

// `ancestorIds` are the parent's ancestors (nearest first); a cycle means the
// moving node is the parent or one of its ancestors.
export function parentProblem(args: { nodeId: string | null; parentNodeId: string | null; parent: ParentLike; pageId: string; ancestorIds: string[] }) {
  const { nodeId, parentNodeId, parent, pageId, ancestorIds } = args;
  if (parentNodeId === null) return null;
  if (nodeId !== null && parentNodeId === nodeId) return "An item can't be its own parent.";
  if (!parent) return "The parent item doesn't exist.";
  if (parent.archived) return "The parent item is archived.";
  if (parent.pageId !== pageId) return "The parent item is on a different page.";
  if (nodeId !== null && ancestorIds.includes(nodeId)) return "That parent is inside the item being moved (it would create a loop).";
  return null;
}

// ---- schedules ----

export type ScheduleFields = {
  kind?: string;
  taskStatus?: string | null;
  dueAt?: number | null;
  dueEndAt?: number | null;
  dueTime?: string | null;
  dueTimeZone?: string | null;
  recurrenceFrequency?: unknown;
};

const SCHEDULE_KEYS = ["kind", "taskStatus", "dueAt", "dueEndAt", "dueTime", "dueTimeZone", "recurrenceFrequency"] as const;

// Reads the schedule fields from a node document or a write (patch/insert);
// recurrence lives in sourceMeta. Absent keys stay absent.
export function scheduleFieldsOf(value: Record<string, unknown> | null | undefined): ScheduleFields {
  const result: Record<string, unknown> = {};
  if (!value) return result;
  for (const key of SCHEDULE_KEYS) {
    if (key !== "recurrenceFrequency" && key in value && value[key] !== undefined) result[key] = value[key];
  }
  const meta = value.sourceMeta;
  if (meta && typeof meta === "object" && "recurrenceFrequency" in meta) {
    const recurrence = (meta as Record<string, unknown>).recurrenceFrequency;
    if (recurrence !== undefined) result.recurrenceFrequency = recurrence;
  }
  return result as ScheduleFields;
}

export type ScheduleResult = {
  // Field overrides to apply (enforce mode); empty when nothing to fix.
  fixes: Partial<Record<keyof ScheduleFields, null>>;
  // One line per fix or refusal, for the violation log.
  problems: string[];
  // Set when the write should be refused outright.
  refusal: string | null;
};

// Checks the state a write leaves behind. `before` is the existing node (null
// for a create); `write` holds only the fields the write sets. Pre-existing
// problems in fields the write doesn't touch are left alone.
export function checkSchedule(before: ScheduleFields | null, rawWrite: ScheduleFields): ScheduleResult {
  // A field the write sets to its current value isn't a change (patches often
  // copy the whole sourceMeta, recurrence included).
  const write: ScheduleFields = {};
  for (const [key, value] of Object.entries(rawWrite) as [keyof ScheduleFields, unknown][]) {
    if (before && key in before && JSON.stringify(before[key]) === JSON.stringify(value)) continue;
    (write as Record<string, unknown>)[key] = value;
  }
  const fixes: ScheduleResult["fixes"] = {};
  const problems: string[] = [];
  let refusal: string | null = null;
  const touched = (key: keyof ScheduleFields) => key in write;
  if (!SCHEDULE_KEYS.some(touched)) return { fixes, problems, refusal };
  const after: ScheduleFields = { ...(before ?? {}), ...write };
  const isTask = (after.kind ?? "note") === "task";

  if ((touched("kind") || touched("taskStatus")) && !isTask && after.taskStatus != null) {
    fixes.taskStatus = null;
    problems.push(`a note can't have task status "${after.taskStatus}"`);
  }

  if (touched("dueAt") && write.dueAt === null) {
    for (const key of ["dueEndAt", "dueTime", "dueTimeZone", "recurrenceFrequency"] as const) {
      // On a create, recurrence without a due date is refused below instead.
      if (key === "recurrenceFrequency" && before === null) continue;
      if (after[key] != null) {
        fixes[key] = null;
        problems.push(`clearing the due date leaves ${key} set`);
      }
    }
  }

  if ((touched("dueAt") || touched("dueEndAt")) && after.dueEndAt != null && !("dueEndAt" in fixes)) {
    if (after.dueAt == null || after.dueEndAt <= after.dueAt) {
      fixes.dueEndAt = null;
      problems.push(after.dueAt == null ? "end date without a due date" : "end date isn't after the due date");
    }
  }

  if (touched("recurrenceFrequency") && write.recurrenceFrequency != null && after.dueAt == null) {
    refusal = "A recurring item needs a due date.";
    problems.push("recurrence without a due date");
  }

  return { fixes, problems, refusal };
}

// Applies schedule fixes to a write. Recurrence goes into sourceMeta.
export function applyScheduleFixes<T extends Record<string, unknown>>(write: T, fixes: ScheduleResult["fixes"], baseSourceMeta?: unknown): T {
  const next: Record<string, unknown> = { ...write };
  for (const [key, value] of Object.entries(fixes)) {
    if (key === "recurrenceFrequency") {
      const meta = (next.sourceMeta ?? baseSourceMeta ?? {}) as Record<string, unknown>;
      next.sourceMeta = { ...meta, recurrenceFrequency: value };
    } else {
      next[key] = value;
    }
  }
  return next as T;
}

// The most restrictive change an update makes, for assertNodeEditable.
export function changeForUpdate(
  before: { kind: string; taskStatus: string | null; sourceMeta?: unknown },
  update: { kind?: string; taskStatus?: string | null; noteCompleted?: boolean; text?: string; dueAt?: unknown; dueEndAt?: unknown; dueTime?: unknown; recurrenceFrequency?: unknown },
): NodeChange {
  if (update.kind !== undefined && update.kind !== before.kind) return "kind";
  if (update.taskStatus !== undefined && update.taskStatus !== before.taskStatus) return "status";
  if (update.noteCompleted !== undefined && update.noteCompleted !== (metaOf(before).noteCompleted === true)) return "status";
  if (update.dueAt !== undefined || update.dueEndAt !== undefined || update.dueTime !== undefined || update.recurrenceFrequency !== undefined) {
    return "schedule";
  }
  return update.text !== undefined ? "text" : "other";
}
