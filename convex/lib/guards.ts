// Server-side write guards (Phase 2 of docs/server-logic-plan.md).
//
// Every public write mutation starts with `const ctx = withGuards(rawCtx, "module:name")`.
// That wrapper:
// - bumps the node `revision` counter on every node insert, patch and replace
//   made through ctx.db (in both modes), and
// - tells the guard helpers below which mutation is running.
//
// The guard helpers check the inputs a write was given. In "record" mode a
// violation is logged to the guardViolations table and the write continues
// unchanged; in "enforce" mode it throws a ConvexError (or, for schedules,
// the write is normalized). The mode lives in ./guardRules.ts.
import { ConvexError } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import {
  GUARD_MODE,
  applyScheduleFixes,
  checkSchedule,
  nodeEditProblem,
  pageWriteProblem,
  parentProblem,
  scheduleFieldsOf,
  type GuardMode,
  type GuardName,
  type NodeChange,
} from "./guardRules";

type GuardState = { mutation: string; mode: GuardMode; recorded: number; writeScopes: Set<Map<string, number | null>> };
const guardStates = new WeakMap<object, GuardState>();
// Keeps one runaway batch from writing thousands of log rows.
const MAX_RECORDS_PER_CALL = 50;
const MAX_ANCESTOR_STEPS = 500;

type Db = MutationCtx["db"];

// Wraps a database writer so node writes carry a revision counter. Phase 3 and
// 4 use it to detect stale requests. `onWrite` hears about each node write
// with the node's revision just before it (null for an insert).
export function withNodeRevisions(db: Db, onWrite?: (nodeId: string, revisionBefore: number | null) => void): Db {
  const isNodeId = (table: unknown, id: unknown) =>
    table === "nodes" || (table === undefined && typeof id === "string" && db.normalizeId("nodes", id) !== null);
  const bump = async (id: unknown, value: Record<string, unknown>) => {
    const current = (await db.get(id as Id<"nodes">)) as { revision?: number } | null;
    if (current) onWrite?.(id as string, current.revision ?? 0);
    return { ...value, revision: (current?.revision ?? 0) + 1 };
  };
  const rewrite =
    (method: "patch" | "replace") =>
    async (...args: unknown[]) => {
      const tableFirst = args.length >= 3;
      const [table, id, value] = tableFirst ? args : [undefined, args[0], args[1]];
      const nextValue = isNodeId(table, id) ? await bump(id, value as Record<string, unknown>) : value;
      const call = db[method] as (...callArgs: unknown[]) => Promise<void>;
      return tableFirst ? call.call(db, table, id, nextValue) : call.call(db, id, nextValue);
    };
  const insert = async (table: string, value: Record<string, unknown>) => {
    const id = await (db.insert as (t: string, v: unknown) => Promise<unknown>).call(db, table, table === "nodes" ? { revision: 1, ...value } : value);
    if (table === "nodes") onWrite?.(id as string, null);
    return id;
  };

  return new Proxy(db, {
    get(target, prop) {
      if (prop === "patch") return rewrite("patch");
      if (prop === "replace") return rewrite("replace");
      if (prop === "insert") return insert;
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export function withGuards(ctx: MutationCtx, mutation: string, options: { mode?: GuardMode } = {}): MutationCtx {
  const writeScopes = new Set<Map<string, number | null>>();
  const noteWrite = (nodeId: string, revisionBefore: number | null) => {
    for (const scope of writeScopes) if (!scope.has(nodeId)) scope.set(nodeId, revisionBefore);
  };
  const wrapped = { ...ctx, db: withNodeRevisions(ctx.db, noteWrite) } as MutationCtx;
  guardStates.set(wrapped, { mutation, mode: options.mode ?? GUARD_MODE, recorded: 0, writeScopes });
  return wrapped;
}

// Records the nodes written from now until stop(), each with its revision
// before the first of those writes (null for nodes inserted). Undo receipts
// use it to know what an action touched and where it started.
export function trackNodeWrites(ctx: MutationCtx) {
  const writes = new Map<string, number | null>();
  const { writeScopes } = stateOf(ctx);
  writeScopes.add(writes);
  return { writes: writes as ReadonlyMap<string, number | null>, stop: () => writeScopes.delete(writes) };
}

function stateOf(ctx: MutationCtx): GuardState {
  let state = guardStates.get(ctx);
  if (!state) {
    state = { mutation: "unknown", mode: GUARD_MODE, recorded: 0, writeScopes: new Set() };
    guardStates.set(ctx, state);
  }
  return state;
}

export function guardMode(ctx: MutationCtx) {
  return stateOf(ctx).mode;
}

async function record(
  ctx: MutationCtx,
  guard: GuardName,
  ids: { nodeId?: string | null; pageId?: string | null },
  detail: string,
) {
  const state = stateOf(ctx);
  if (state.recorded >= MAX_RECORDS_PER_CALL) return;
  state.recorded += 1;
  await ctx.db.insert("guardViolations", {
    mutation: state.mutation,
    guard,
    mode: state.mode,
    nodeId: ids.nodeId ?? undefined,
    pageId: ids.pageId ?? undefined,
    detail: detail.slice(0, 500),
    createdAt: Date.now(),
  });
}

// Throws in enforce mode; logs and lets the write continue in record mode.
async function violation(
  ctx: MutationCtx,
  guard: GuardName,
  message: string,
  ids: { nodeId?: string | null; pageId?: string | null },
  detail?: string,
) {
  if (stateOf(ctx).mode === "enforce") throw new ConvexError(message);
  await record(ctx, guard, ids, detail ?? message);
}

// The page must exist, not be archived and not be pending deletion.
export async function assertPageWritable(ctx: MutationCtx, pageId: Id<"pages">) {
  const page = await ctx.db.get(pageId);
  const problem = pageWriteProblem(page);
  if (problem) await violation(ctx, "assertPageWritable", problem, { pageId });
  return page;
}

// Locked items (section headers, planner days) can't be moved, archived,
// deleted or have their kind or status changed; nothing on an archived or
// pending-deletion page can be edited.
export async function assertNodeEditable(ctx: MutationCtx, nodeOrId: Doc<"nodes"> | Id<"nodes">, change: NodeChange) {
  const node = typeof nodeOrId === "string" ? await ctx.db.get(nodeOrId) : nodeOrId;
  const page = node ? await ctx.db.get(node.pageId) : null;
  const problem = nodeEditProblem({ node, page, change });
  if (problem) {
    await violation(ctx, "assertNodeEditable", problem, {
      nodeId: typeof nodeOrId === "string" ? nodeOrId : nodeOrId._id,
      pageId: node?.pageId,
    }, `${change}: ${problem}`);
  }
  return node;
}

// The parent must exist, be active, be on the target page, and not be the
// node itself or inside it.
export async function assertValidParent(
  ctx: MutationCtx,
  args: { nodeId: Id<"nodes"> | null; parentNodeId: Id<"nodes"> | null; pageId: Id<"pages"> },
) {
  if (args.parentNodeId === null) return;
  const parent = await ctx.db.get(args.parentNodeId);
  const ancestorIds: string[] = [];
  let cursor = parent?.parentNodeId ?? null;
  const seen = new Set<string>();
  while (cursor && ancestorIds.length < MAX_ANCESTOR_STEPS && !seen.has(cursor)) {
    seen.add(cursor);
    ancestorIds.push(cursor);
    if (cursor === args.nodeId) break;
    cursor = (await ctx.db.get(cursor))?.parentNodeId ?? null;
  }
  const problem = parentProblem({
    nodeId: args.nodeId,
    parentNodeId: args.parentNodeId,
    parent: parent ? { _id: parent._id, pageId: parent.pageId, archived: parent.archived } : null,
    pageId: args.pageId,
    ancestorIds,
  });
  if (problem) {
    await violation(ctx, "assertValidParent", problem, { nodeId: args.nodeId, pageId: args.pageId }, `parent ${args.parentNodeId}: ${problem}`);
  }
  // Callers that must refuse a broken tree even in record mode (moveNodeTree)
  // throw on this themselves.
  return problem;
}

// Checks the schedule a write leaves behind (see checkSchedule). Returns the
// write to use: unchanged in record mode, normalized in enforce mode.
export async function normalizeSchedule<T extends Record<string, unknown>>(
  ctx: MutationCtx,
  args: { before: Doc<"nodes"> | null; write: T; nodeId?: Id<"nodes"> | null; pageId?: Id<"pages"> | null },
): Promise<T> {
  const result = checkSchedule(
    args.before ? scheduleFieldsOf(args.before as unknown as Record<string, unknown>) : null,
    scheduleFieldsOf(args.write),
  );
  if (result.problems.length === 0) return args.write;
  const ids = { nodeId: args.nodeId ?? args.before?._id ?? null, pageId: args.pageId ?? args.before?.pageId ?? null };
  if (result.refusal) {
    // Throws in enforce mode; in record mode, logs once and keeps the write.
    await violation(ctx, "normalizeSchedule", result.refusal, ids, result.problems.join("; "));
    return args.write;
  }
  if (guardMode(ctx) === "enforce") return applyScheduleFixes(args.write, result.fixes, args.before?.sourceMeta);
  await record(ctx, "normalizeSchedule", ids, result.problems.join("; "));
  return args.write;
}
