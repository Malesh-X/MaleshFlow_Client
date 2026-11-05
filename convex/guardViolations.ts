import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { authorizeCaller } from "./lib/agentAuth";
import { assertOwnerKeyGuarded } from "./lib/authThrottle";
import { withGuards } from "./lib/guards";
import { GUARD_NAMES, currentGuardMode } from "./lib/guardRules";
import { GUARD_REFUSAL_CALLERS } from "../lib/domain/guardRefusal";

const MAX_LIST = 500;
// Refusal reports kept per minute, so a looping caller can't flood the table.
const MAX_REPORTS_PER_MINUTE = 30;

const groupKey = (row: { mutation: string; guard: string; caller?: string }) =>
  `${row.mutation} / ${row.guard}${row.caller ? ` / ${row.caller}` : ""}`;

// Recent writes the guards flagged (convex/lib/guards.ts), newest first, with
// counts and first/last times by mutation, guard and caller. Read by `flow doctor`.
export const list = query({
  args: {
    ownerKey: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await assertOwnerKeyGuarded(ctx.db, args.ownerKey);
    const limit = Math.max(1, Math.min(args.limit ?? 100, MAX_LIST));
    const rows = await ctx.db.query("guardViolations").withIndex("by_createdAt").order("desc").take(MAX_LIST + 1);
    const counts: Record<string, number> = {};
    const groups = new Map<string, { key: string; count: number; first: number; last: number }>();
    for (const row of rows.slice(0, MAX_LIST)) {
      const key = groupKey(row);
      counts[key] = (counts[key] ?? 0) + 1;
      const group = groups.get(key) ?? { key, count: 0, first: row.createdAt, last: row.createdAt };
      group.count += 1;
      group.first = Math.min(group.first, row.createdAt);
      group.last = Math.max(group.last, row.createdAt);
      groups.set(key, group);
    }
    return {
      mode: currentGuardMode(),
      total: Math.min(rows.length, MAX_LIST),
      truncated: rows.length > MAX_LIST,
      counts,
      groups: [...groups.values()].sort((a, b) => b.count - a.count),
      recent: rows.slice(0, limit).map((row) => ({
        mutation: row.mutation,
        guard: row.guard,
        mode: row.mode,
        caller: row.caller ?? null,
        nodeId: row.nodeId ?? null,
        pageId: row.pageId ?? null,
        detail: row.detail,
        createdAt: row.createdAt,
      })),
    };
  },
});

// Logs a write the guards refused in enforce mode. The refused mutation rolls
// back its own log row, so the app, the CLI and the MCP server report it here
// (lib/domain/guardRefusal.ts). Agent tokens are accepted so MCP refusals are
// logged; an agent's report is always recorded as "mcp".
export const reportRefusal = mutation({
  args: {
    ownerKey: v.string(),
    caller: v.union(...GUARD_REFUSAL_CALLERS.map((name) => v.literal(name))),
    mutation: v.string(),
    guard: v.string(),
    detail: v.string(),
    nodeId: v.optional(v.string()),
    pageId: v.optional(v.string()),
  },
  returns: v.null(),
  handler: async (rawCtx, args) => {
    const ctx = withGuards(rawCtx, "guardViolations:reportRefusal");
    const who = await authorizeCaller(ctx.db, args.ownerKey, "guardViolations:reportRefusal");
    if (!(GUARD_NAMES as readonly string[]).includes(args.guard)) return null;
    const now = Date.now();
    const lastMinute = await ctx.db
      .query("guardViolations")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", now - 60_000))
      .take(MAX_REPORTS_PER_MINUTE);
    if (lastMinute.length >= MAX_REPORTS_PER_MINUTE) return null;
    await ctx.db.insert("guardViolations", {
      mutation: args.mutation.slice(0, 100),
      guard: args.guard,
      mode: "enforce",
      caller: who.kind === "agent" ? "mcp" : args.caller,
      nodeId: args.nodeId?.slice(0, 64),
      pageId: args.pageId?.slice(0, 64),
      detail: args.detail.slice(0, 500),
      createdAt: now,
    });
    return null;
  },
});
