/// <reference types="vite/client" />
// Completing a planner copy of a recurring task that lives in the same
// planner's sidebar: the copy moves to Past Weeks, the source advances once
// (past occurrences skipped in due-date mode) and the next occurrence is
// copied into its planner day.
import { convexTest } from "convex-test";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import { appendPlannerDayCore, appendPlannerLinkedTaskCopy } from "../convex/lib/planner";
import schema from "../convex/schema";
import { zonedNoon } from "../lib/domain/timeZone";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";
const HNL = "Pacific/Honolulu";
const nov = (d: number) => zonedNoon({ year: 2026, month: 11, day: d }, HNL);
const oct = (d: number) => zonedNoon({ year: 2026, month: 10, day: d }, HNL);
type Meta = Record<string, unknown>;

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T20:00:00Z")); // 10 a.m. Nov 2 in Honolulu
});
afterEach(() => vi.useRealTimers());

async function setup(sourceDueAt: number, frequency: unknown = { interval: 4, unit: "day" }) {
  const t = convexTest(schema, modules);
  await t.mutation(api.workspace.setWorkspaceSettings, { ownerKey, timeZone: HNL, completionMode: "dueDate" });
  const get = (id: Id<"nodes">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"nodes">>;
  const all = () => t.run((ctx) => ctx.db.query("nodes").collect());
  const pageId = await t.mutation(api.workspace.createPage, { ownerKey, title: "Plan", sidebarSection: "Tasks", pageType: "planner" });
  await t.mutation(api.planner.ensurePlannerPageSections, { ownerKey, pageId });
  const days = new Map<number, Id<"nodes">>();
  for (let d = 2; d <= 8; d += 1) {
    const result = await t.run(async (ctx) => appendPlannerDayCore(ctx, { page: (await ctx.db.get(pageId))!, plannerDate: nov(d) }));
    days.set(d, result.dayNodeId as Id<"nodes">);
  }
  const slot = async (name: string) => (await all()).find((n) => (n.sourceMeta as Meta | undefined)?.sectionSlot === name)!._id;
  const sidebar = await slot("plannerSidebar");
  const focus = await slot("plannerFocus");
  const source = await t.mutation(api.workspace.createNode, {
    ownerKey, pageId, parentNodeId: sidebar, text: "Go to the gym", kind: "task", taskStatus: "todo", dueAt: sourceDueAt, recurrenceFrequency: frequency as never,
  });
  const copyUnder = (parentNodeId: Id<"nodes">, plannerDate: number, withToken = true) =>
    t.run(async (ctx) => {
      const id = (await appendPlannerLinkedTaskCopy(ctx, {
        plannerPageId: pageId, parentNodeId, plannerDate, afterNodeId: null,
        sourceTask: { ...(await ctx.db.get(source))!, dueEndAt: null },
      })) as Id<"nodes">;
      if (!withToken) {
        const meta = { ...((await ctx.db.get(id))!.sourceMeta as Meta) };
        delete meta.sourceOccurrenceToken;
        await ctx.db.patch(id, { sourceMeta: meta });
      }
      return id;
    });
  // The app's checkbox: workspace:setNodeCompletion with the revision it saw.
  const complete = async (nodeId: Id<"nodes">) =>
    t.mutation(api.workspace.setNodeCompletion, {
      ownerKey, nodeId, intent: "complete", completionMode: "dueDate", expectedRevision: (await get(nodeId)).revision ?? 0,
    });
  const activeCopiesUnder = async (parentNodeId: Id<"nodes">) =>
    (await all()).filter((n) => !n.archived && n.parentNodeId === parentNodeId && (n.sourceMeta as Meta | undefined)?.sourceTaskNodeId === source);
  const pastWeeksCopies = async () => {
    const pages = await t.run((ctx) => ctx.db.query("pages").collect());
    const pastWeeks = pages.find((p) => p.title === "Past Weeks");
    return (await all()).filter((n) => n.pageId === pastWeeks?._id && (n.sourceMeta as Meta | undefined)?.sourceTaskNodeId === source);
  };
  return { t, get, pageId, days, focus, source, copyUnder, complete, activeCopiesUnder, pastWeeksCopies };
}

describe("planner copy of a recurring sidebar task", () => {
  for (const where of ["day", "focus"] as const) {
    for (const withToken of [true, false]) {
      test(`${where} copy ${withToken ? "with" : "without"} an occurrence token: Past Weeks, one advance, next copy`, async () => {
        const s = await setup(oct(20));
        const parent = where === "day" ? s.days.get(2)! : s.focus;
        const copy = await s.copyUnder(parent, nov(2), withToken);

        expect(await s.complete(copy)).toMatchObject({ status: "applied", route: "planner" });

        expect((await s.get(copy)).archived).toBe(true);
        expect((await s.pastWeeksCopies()).length).toBe(1);
        const source = await s.get(s.source);
        expect(source.taskStatus).toBe("todo");
        // Oct 20 every 4 days: Oct 24, 28, Nov 1 are past; Nov 5 is next.
        expect(source.dueAt).toBe(nov(5));
        expect((source.sourceMeta as Meta).occurrenceIndex).toBe(1);
        const next = await s.activeCopiesUnder(s.days.get(5)!);
        expect(next.length).toBe(1);
        expect((next[0]!.sourceMeta as Meta).sourceOccurrenceToken).toBe("1");
      });
    }
  }

  test("a source due today advances one step", async () => {
    const s = await setup(nov(2));
    const copy = await s.copyUnder(s.days.get(2)!, nov(2));
    await s.complete(copy);
    expect((await s.get(s.source)).dueAt).toBe(nov(6));
    expect((await s.activeCopiesUnder(s.days.get(6)!)).length).toBe(1);
  });

  test("a day copy and a focus copy of one occurrence advance the source once", async () => {
    const s = await setup(nov(2), "daily");
    const dayCopy = await s.copyUnder(s.days.get(2)!, nov(2));
    const focusCopy = await s.copyUnder(s.focus, nov(2));
    await s.complete(dayCopy);
    expect((await s.get(s.source)).dueAt).toBe(nov(3));
    await s.complete(focusCopy);
    const source = await s.get(s.source);
    expect(source.dueAt).toBe(nov(3));
    expect((source.sourceMeta as Meta).occurrenceIndex).toBe(1);
    expect((await s.get(focusCopy)).archived).toBe(true);
    expect((await s.activeCopiesUnder(s.days.get(3)!)).length).toBe(1);
  });

  test("completing the sidebar source directly also skips past occurrences", async () => {
    const s = await setup(oct(20));
    expect(await s.complete(s.source)).toMatchObject({ status: "applied", route: "recurring" });
    expect((await s.get(s.source)).dueAt).toBe(nov(5));
    expect((await s.activeCopiesUnder(s.days.get(5)!)).length).toBe(1);
  });
});
