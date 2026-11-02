// Calendar-date math in an explicit IANA time zone, so the browser (local time)
// and the Convex server (UTC) get the same dates. No dependencies: uses Intl.

export type CalendarDate = { year: number; month: number; day: number };

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string) {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

export function isValidTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== "string" || timeZone.length === 0) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

function zonedFields(ms: number, timeZone: string) {
  const fields: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") fields[part.type] = Number(part.value);
  }
  return fields as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

// The calendar date `ms` falls on in `timeZone`.
export function zonedCalendarDate(ms: number, timeZone: string): CalendarDate {
  const { year, month, day } = zonedFields(ms, timeZone);
  return { year, month, day };
}

// How far `timeZone` is ahead of UTC at `ms`, in milliseconds.
export function timeZoneOffsetMs(ms: number, timeZone: string) {
  const f = zonedFields(ms, timeZone);
  const asUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

// Noon on `date` in `timeZone`, as a UTC timestamp. Noon keeps a date safely
// inside the same calendar day across DST shifts.
export function zonedNoon(date: CalendarDate, timeZone: string) {
  const wallClock = Date.UTC(date.year, date.month - 1, date.day, 12, 0, 0, 0);
  let guess = wallClock - timeZoneOffsetMs(wallClock, timeZone);
  // A second pass settles the rare case where the offset differs at the guess.
  guess = wallClock - timeZoneOffsetMs(guess, timeZone);
  return guess;
}

// Adds calendar units the way Date#setDate/setMonth/setFullYear do (so Jan 31
// plus one month rolls into March, matching the app's existing behavior).
export function addCalendarUnits(date: CalendarDate, unit: "day" | "week" | "month" | "year", amount: number): CalendarDate {
  const value = new Date(Date.UTC(date.year, date.month - 1, date.day, 12));
  if (unit === "day") value.setUTCDate(value.getUTCDate() + amount);
  if (unit === "week") value.setUTCDate(value.getUTCDate() + amount * 7);
  if (unit === "month") value.setUTCMonth(value.getUTCMonth() + amount);
  if (unit === "year") value.setUTCFullYear(value.getUTCFullYear() + amount);
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

// Day of week (0 = Sunday) of the calendar date `ms` falls on in `timeZone`.
export function zonedWeekday(ms: number, timeZone: string) {
  const { year, month, day } = zonedCalendarDate(ms, timeZone);
  return new Date(Date.UTC(year, month - 1, day, 12)).getUTCDay();
}

// The zone to use for an item's dates: its own zone when set, otherwise the
// workspace zone. Null means "the runtime's local zone" (browser only).
export function resolveTimeZone(itemTimeZone: unknown, workspaceTimeZone: unknown): string | null {
  if (isValidTimeZone(itemTimeZone)) return itemTimeZone;
  if (isValidTimeZone(workspaceTimeZone)) return workspaceTimeZone;
  return null;
}
