import { v } from "convex/values";
import { query } from "./_generated/server";
import { assertOwnerKeyGuarded } from "./lib/authThrottle";
import { GUARD_MODE } from "./lib/guardRules";

const MAX_LIST = 500;

// Recent writes the guards flagged (convex/lib/guards.ts), newest first, with
// counts by mutation and guard. Read by `flow doctor`.
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
    for (const row of rows.slice(0, MAX_LIST)) {
      const key = `${row.mutation} / ${row.guard}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return {
      mode: GUARD_MODE,
      total: Math.min(rows.length, MAX_LIST),
      truncated: rows.length > MAX_LIST,
      counts,
      recent: rows.slice(0, limit).map((row) => ({
        mutation: row.mutation,
        guard: row.guard,
        mode: row.mode,
        nodeId: row.nodeId ?? null,
        pageId: row.pageId ?? null,
        detail: row.detail,
        createdAt: row.createdAt,
      })),
    };
  },
});
