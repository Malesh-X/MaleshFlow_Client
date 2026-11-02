/// <reference types="vite/client" />
// Server-side recurring roll-forward uses the workspace (or item) time zone,
// not the server's UTC clock (Phase 3, change 1).
import { convexTest } from "convex-test";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { api } from "../convex/_generated/api";
import schema from "../convex/schema";
import { zonedCalendarDate, zonedNoon } from "../lib/domain/timeZone";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";
const HNL = "Pacific/Honolulu";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
  vi.useFakeTimers();
  // 3:30 p.m. on Nov 1 in Honolulu; already Nov 2 in UTC.
  vi.setSystemTime(new Date("2026-11-02T01:30:00Z"));
});
afterEach(() => {
  vi.useRealTimers();
});

async function recurringTask(timeZone: string | null) {
  const t = convexTest(schema, modules);
  if (timeZone) await t.mutation(api.workspace.setWorkspaceSettings, { ownerKey, timeZone });
  const pageId = await t.mutation(api.workspace.createPage, { ownerKey, title: "Tasks", sidebarSection: "Tasks", pageType: "task" });
  const nodeId = await t.mutation(api.workspace.createNode, {
    ownerKey,
    pageId,
    text: "Daily",
    kind: "task",
    taskStatus: "todo",
    dueAt: zonedNoon({ year: 2026, month: 10, day: 30 }, HNL),
    recurrenceFrequency: "daily",
  });
  const dueAt = async () => (await t.run((ctx) => ctx.db.get(nodeId)))!.dueAt!;
  return { t, nodeId, dueAt };
}

test("settings round-trip and reject unknown zones", async () => {
  const t = convexTest(schema, modules);
  expect(await t.query(api.workspace.getWorkspaceSettings, { ownerKey })).toEqual({ timeZone: null, completionMode: null });
  await t.mutation(api.workspace.setWorkspaceSettings, { ownerKey, timeZone: HNL, completionMode: "today" });
  expect(await t.query(api.workspace.getWorkspaceSettings, { ownerKey })).toEqual({ timeZone: HNL, completionMode: "today" });
  await expect(t.mutation(api.workspace.setWorkspaceSettings, { ownerKey, timeZone: "Nope/Zone" })).rejects.toThrow(/Unknown time zone/);
});

test("today mode: Honolulu workspace rolls a daily task to Nov 2, not Nov 3", async () => {
  const { t, nodeId, dueAt } = await recurringTask(HNL);
  await t.mutation(api.workspace.completeTaskPageTask, { ownerKey, nodeId, completionMode: "today" });
  expect(zonedCalendarDate(await dueAt(), HNL)).toEqual({ year: 2026, month: 11, day: 2 });
});

test("today mode without a workspace zone falls back to UTC (Nov 3)", async () => {
  const { t, nodeId, dueAt } = await recurringTask(null);
  await t.mutation(api.workspace.completeTaskPageTask, { ownerKey, nodeId, completionMode: "today" });
  expect(zonedCalendarDate(await dueAt(), "UTC")).toEqual({ year: 2026, month: 11, day: 3 });
});

test("dueDate mode keeps the cadence and skips past days in the workspace zone", async () => {
  const { t, nodeId, dueAt } = await recurringTask(HNL);
  await t.mutation(api.workspace.completeTaskPageTask, { ownerKey, nodeId, completionMode: "dueDate" });
  // Due Oct 30, daily, completed on Nov 1 in Honolulu: Oct 31 and Nov 1 are past.
  expect(await dueAt()).toBe(zonedNoon({ year: 2026, month: 11, day: 2 }, HNL));
});

test("just after midnight Honolulu, today mode moves to the next day", async () => {
  vi.setSystemTime(new Date("2026-11-02T10:01:00Z")); // 00:01 Nov 2 in Honolulu
  const { t, nodeId, dueAt } = await recurringTask(HNL);
  await t.mutation(api.workspace.completeTaskPageTask, { ownerKey, nodeId, completionMode: "today" });
  expect(zonedCalendarDate(await dueAt(), HNL)).toEqual({ year: 2026, month: 11, day: 3 });
});
