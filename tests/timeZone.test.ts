import test from "node:test";
import assert from "node:assert/strict";
import { advanceRecurringDueDate, advanceRecurringDueDateRange, getTodayReferenceDate } from "../lib/domain/recurrence";
import { addPlannerCalendarDays, getPlannerWeekdayName, plannerDayMatchesDueDateRange } from "../lib/domain/planner";
import {
  addCalendarUnits,
  isValidTimeZone,
  resolveTimeZone,
  timeZoneOffsetMs,
  zonedCalendarDate,
  zonedNoon,
  zonedWeekday,
} from "../lib/domain/timeZone";

const HNL = "Pacific/Honolulu";
const TOKYO = "Asia/Tokyo";
const NY = "America/New_York";
const iso = (ms: number) => new Date(ms).toISOString();

test("zonedCalendarDate and zonedNoon", () => {
  // 2026-11-02T01:30Z is 3:30 p.m. on Nov 1 in Honolulu.
  assert.deepEqual(zonedCalendarDate(Date.parse("2026-11-02T01:30:00Z"), HNL), { year: 2026, month: 11, day: 1 });
  assert.deepEqual(zonedCalendarDate(Date.parse("2026-11-02T01:30:00Z"), "UTC"), { year: 2026, month: 11, day: 2 });
  assert.equal(iso(zonedNoon({ year: 2026, month: 11, day: 2 }, HNL)), "2026-11-02T22:00:00.000Z");
  assert.equal(iso(zonedNoon({ year: 2026, month: 11, day: 2 }, TOKYO)), "2026-11-02T03:00:00.000Z");
  assert.equal(timeZoneOffsetMs(Date.parse("2026-01-01T00:00:00Z"), HNL), -10 * 3600_000);
});

test("zonedNoon is right on both sides of a DST change", () => {
  // US DST starts 2026-03-08 in New York.
  assert.equal(iso(zonedNoon({ year: 2026, month: 3, day: 7 }, NY)), "2026-03-07T17:00:00.000Z");
  assert.equal(iso(zonedNoon({ year: 2026, month: 3, day: 8 }, NY)), "2026-03-08T16:00:00.000Z");
  assert.equal(iso(zonedNoon({ year: 2026, month: 11, day: 1 }, NY)), "2026-11-01T17:00:00.000Z");
});

test("addCalendarUnits matches Date#setMonth rollover", () => {
  assert.deepEqual(addCalendarUnits({ year: 2026, month: 1, day: 31 }, "month", 1), { year: 2026, month: 3, day: 3 });
  assert.deepEqual(addCalendarUnits({ year: 2026, month: 12, day: 31 }, "day", 1), { year: 2027, month: 1, day: 1 });
  assert.deepEqual(addCalendarUnits({ year: 2024, month: 2, day: 29 }, "year", 1), { year: 2025, month: 3, day: 1 });
  assert.deepEqual(addCalendarUnits({ year: 2026, month: 11, day: 1 }, "week", 2), { year: 2026, month: 11, day: 15 });
});

test("the plan's example: a daily completion at 3:30 p.m. Honolulu on Nov 1 is due Nov 2, on any runtime", () => {
  const now = new Date("2026-11-02T01:30:00Z");
  const dueAt = zonedNoon({ year: 2026, month: 10, day: 30 }, HNL);
  const next = advanceRecurringDueDate({ dueAt, frequency: "daily", mode: "today", now, timeZone: HNL });
  assert.deepEqual(zonedCalendarDate(next, HNL), { year: 2026, month: 11, day: 2 });
  assert.equal(iso(next), "2026-11-02T22:00:00.000Z");
  // A UTC server without the zone would say Nov 3.
  const utc = advanceRecurringDueDate({ dueAt, frequency: "daily", mode: "today", now, timeZone: "UTC" });
  assert.deepEqual(zonedCalendarDate(utc, "UTC"), { year: 2026, month: 11, day: 3 });
});

test("completions just before and after midnight in a non-UTC zone, in both modes", () => {
  const dueAt = zonedNoon({ year: 2026, month: 11, day: 10 }, TOKYO);
  const beforeMidnight = new Date("2026-11-04T14:59:00Z"); // 23:59 Nov 4 in Tokyo
  const afterMidnight = new Date("2026-11-04T15:01:00Z"); // 00:01 Nov 5 in Tokyo
  const day = (ms: number) => zonedCalendarDate(ms, TOKYO).day;

  assert.equal(day(advanceRecurringDueDate({ dueAt, frequency: "daily", mode: "today", now: beforeMidnight, timeZone: TOKYO })), 5);
  assert.equal(day(advanceRecurringDueDate({ dueAt, frequency: "daily", mode: "today", now: afterMidnight, timeZone: TOKYO })), 6);
  // dueDate mode ignores the clock.
  assert.equal(day(advanceRecurringDueDate({ dueAt, frequency: "daily", mode: "dueDate", now: beforeMidnight, timeZone: TOKYO })), 11);
  assert.equal(day(advanceRecurringDueDate({ dueAt, frequency: "daily", mode: "dueDate", now: afterMidnight, timeZone: TOKYO })), 11);
  assert.equal(day(advanceRecurringDueDate({ dueAt, frequency: { interval: 2, unit: "week" }, mode: "dueDate", timeZone: TOKYO })), 24);
});

test("advanceRecurringDueDateRange keeps the range length with a zone", () => {
  const dueAt = zonedNoon({ year: 2026, month: 11, day: 1 }, HNL);
  const dueEndAt = zonedNoon({ year: 2026, month: 11, day: 3 }, HNL);
  const next = advanceRecurringDueDateRange({ dueAt, dueEndAt, frequency: "weekly", mode: "dueDate", timeZone: HNL });
  assert.deepEqual(zonedCalendarDate(next.dueAt, HNL), { year: 2026, month: 11, day: 8 });
  assert.deepEqual(zonedCalendarDate(next.dueEndAt!, HNL), { year: 2026, month: 11, day: 10 });
});

test("getTodayReferenceDate uses the zone's date", () => {
  const now = new Date("2026-11-02T01:30:00Z");
  assert.equal(iso(getTodayReferenceDate(now, HNL).getTime()), "2026-11-01T22:00:00.000Z");
});

test("planner date helpers accept a zone", () => {
  const day = zonedNoon({ year: 2026, month: 11, day: 2 }, TOKYO);
  assert.equal(getPlannerWeekdayName(day, TOKYO), "Monday");
  assert.equal(zonedWeekday(day, TOKYO), 1);
  assert.deepEqual(zonedCalendarDate(addPlannerCalendarDays(day, 1, TOKYO), TOKYO), { year: 2026, month: 11, day: 3 });
  assert.equal(plannerDayMatchesDueDateRange({ dayTimestamp: day, dueAt: day, timeZone: TOKYO }), true);
  assert.equal(
    plannerDayMatchesDueDateRange({ dayTimestamp: addPlannerCalendarDays(day, 1, TOKYO), dueAt: day, timeZone: TOKYO }),
    false,
  );
});

test("resolveTimeZone prefers the item's zone, then the workspace zone", () => {
  assert.equal(resolveTimeZone("Asia/Tokyo", HNL), "Asia/Tokyo");
  assert.equal(resolveTimeZone(null, HNL), HNL);
  assert.equal(resolveTimeZone("Not/AZone", null), null);
  assert.equal(isValidTimeZone("Not/AZone"), false);
});
