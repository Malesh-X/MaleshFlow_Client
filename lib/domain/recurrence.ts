import { addCalendarUnits, zonedCalendarDate, zonedNoon, type CalendarDate } from "./timeZone";

export const RECURRENCE_FREQUENCIES = [
  "daily",
  "weekly",
  "monthly",
  "yearly",
] as const;

export const RECURRENCE_UNITS = [
  "day",
  "week",
  "month",
  "year",
] as const;

export type RecurrencePreset = (typeof RECURRENCE_FREQUENCIES)[number];
export type RecurrenceUnit = (typeof RECURRENCE_UNITS)[number];
export type CustomRecurrenceFrequency = {
  interval: number;
  unit: RecurrenceUnit;
};
export type RecurrenceFrequency = RecurrencePreset | CustomRecurrenceFrequency | null;
export type RecurringCompletionMode = "dueDate" | "today";

// The basis used when neither the task nor the workspace sets one: repeat from
// the day the task is completed.
export const DEFAULT_COMPLETION_MODE: RecurringCompletionMode = "today";

// A recurring item's own completion basis (sourceMeta.recurrenceBasis):
// "dueDate" advances from its due date, "today" from the day it's completed.
// Absent means "use the workspace setting".
export function parseRecurrenceBasis(value: unknown): RecurringCompletionMode | null {
  return value === "dueDate" || value === "today" ? value : null;
}

export function getRecurrenceBasis(item: { sourceMeta?: unknown } | null | undefined): RecurringCompletionMode | null {
  const meta = item && typeof item.sourceMeta === "object" && item.sourceMeta ? (item.sourceMeta as Record<string, unknown>) : {};
  return parseRecurrenceBasis(meta.recurrenceBasis);
}

// The mode a completion uses for this item: its own basis, else the fallback
// (the workspace setting the caller sent).
export function completionModeFor(
  item: { sourceMeta?: unknown } | null | undefined,
  fallback: RecurringCompletionMode,
): RecurringCompletionMode {
  return getRecurrenceBasis(item) ?? fallback;
}

function pluralizeRecurrenceUnit(unit: RecurrenceUnit, interval: number) {
  return interval === 1 ? unit : `${unit}s`;
}

export function isRecurrencePreset(
  frequency: RecurrenceFrequency,
): frequency is RecurrencePreset {
  return typeof frequency === "string";
}

export function isCustomRecurrenceFrequency(
  value: unknown,
): value is CustomRecurrenceFrequency {
  if (!value || typeof value !== "object") {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.interval === "number" &&
    Number.isInteger(record.interval) &&
    record.interval > 0 &&
    RECURRENCE_UNITS.includes(record.unit as RecurrenceUnit)
  );
}

export function parseRecurrenceFrequency(value: unknown): RecurrenceFrequency {
  if (value === null || value === undefined) {
    return null;
  }

  if (RECURRENCE_FREQUENCIES.includes(value as RecurrencePreset)) {
    return value as RecurrencePreset;
  }

  if (isCustomRecurrenceFrequency(value)) {
    return {
      interval: value.interval,
      unit: value.unit,
    };
  }

  return null;
}

export function areRecurrenceFrequenciesEqual(
  left: RecurrenceFrequency,
  right: RecurrenceFrequency,
) {
  if (left === right) {
    return true;
  }

  if (!left || !right) {
    return false;
  }

  if (isRecurrencePreset(left) || isRecurrencePreset(right)) {
    return false;
  }

  return left.interval === right.interval && left.unit === right.unit;
}

function toLocalNoon(date: Date) {
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    12,
    0,
    0,
    0,
  );
}

// Noon today. With a time zone, "today" is the date in that zone; without one,
// the runtime's local zone (the browser). The server always passes one.
export function getTodayReferenceDate(now = new Date(), timeZone?: string | null) {
  if (timeZone) return new Date(zonedNoon(zonedCalendarDate(now.getTime(), timeZone), timeZone));
  return toLocalNoon(now);
}

export function timestampToDateInputValue(timestamp: number | null | undefined) {
  if (!timestamp) {
    return "";
  }

  const date = new Date(timestamp);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function dateInputValueToTimestamp(value: string) {
  if (!value) {
    return null;
  }

  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }

  return new Date(year, month - 1, day, 12, 0, 0, 0).getTime();
}

export function formatDueDate(timestamp: number | null | undefined) {
  if (!timestamp) {
    return "";
  }

  const date = new Date(timestamp);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

export function formatDueDateRange(
  startTimestamp: number | null | undefined,
  endTimestamp: number | null | undefined,
) {
  if (!startTimestamp && !endTimestamp) {
    return "";
  }

  if (!startTimestamp) {
    return formatDueDate(endTimestamp);
  }

  if (!endTimestamp || endTimestamp <= startTimestamp) {
    return formatDueDate(startTimestamp);
  }

  return `${formatDueDate(startTimestamp)} - ${formatDueDate(endTimestamp)}`;
}

export function formatCompactDueDate(timestamp: number | null | undefined, now = new Date()) {
  if (!timestamp) {
    return "";
  }

  const date = new Date(timestamp);
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  const compactDate = `${month}/${day}`;
  if (date.getFullYear() === now.getFullYear()) {
    return compactDate;
  }

  const year = `${date.getFullYear()}`.slice(-2).padStart(2, "0");
  return `${compactDate}/${year}`;
}

export function formatCompactDueDateRange(
  startTimestamp: number | null | undefined,
  endTimestamp: number | null | undefined,
  now = new Date(),
) {
  if (!startTimestamp && !endTimestamp) {
    return "";
  }

  if (!startTimestamp) {
    return formatCompactDueDate(endTimestamp, now);
  }

  if (!endTimestamp || endTimestamp <= startTimestamp) {
    return formatCompactDueDate(startTimestamp, now);
  }

  return `${formatCompactDueDate(startTimestamp, now)}-${formatCompactDueDate(
    endTimestamp,
    now,
  )}`;
}

export function isOverdueDueDate(timestamp: number | null | undefined, now = new Date()) {
  if (!timestamp) {
    return false;
  }

  return timestamp < getTodayReferenceDate(now).getTime();
}

export function isOverdueDueDateRange(
  startTimestamp: number | null | undefined,
  endTimestamp: number | null | undefined,
  now = new Date(),
) {
  if (endTimestamp) {
    return endTimestamp < getTodayReferenceDate(now).getTime();
  }

  return isOverdueDueDate(startTimestamp, now);
}

export function getRecurrenceLabel(frequency: RecurrenceFrequency) {
  if (!frequency) {
    return "";
  }

  if (!isRecurrencePreset(frequency)) {
    return `Every ${frequency.interval} ${pluralizeRecurrenceUnit(
      frequency.unit,
      frequency.interval,
    )}`;
  }

  switch (frequency) {
    case "daily":
      return "Daily";
    case "weekly":
      return "Weekly";
    case "monthly":
      return "Monthly";
    case "yearly":
      return "Yearly";
    default:
      return "";
  }
}

export function getCompactRecurrenceLabel(frequency: RecurrenceFrequency) {
  if (!frequency) {
    return "";
  }

  const parsedFrequency = isRecurrencePreset(frequency)
    ? {
        daily: { interval: 1, unit: "day" as const },
        weekly: { interval: 1, unit: "week" as const },
        monthly: { interval: 1, unit: "month" as const },
        yearly: { interval: 1, unit: "year" as const },
      }[frequency]
    : frequency;

  const unitLabel =
    parsedFrequency.unit === "day"
      ? "d"
      : parsedFrequency.unit === "week"
        ? "w"
        : parsedFrequency.unit === "month"
          ? "mo"
          : "y";

  return `${parsedFrequency.interval}${unitLabel}`;
}

function calendarKey(date: CalendarDate) {
  return date.year * 10_000 + date.month * 100 + date.day;
}

function recurrenceStep(frequency: Exclude<RecurrenceFrequency, null>): { unit: RecurrenceUnit; amount: number } {
  if (isRecurrencePreset(frequency)) {
    return {
      daily: { unit: "day" as const, amount: 1 },
      weekly: { unit: "week" as const, amount: 1 },
      monthly: { unit: "month" as const, amount: 1 },
      yearly: { unit: "year" as const, amount: 1 },
    }[frequency];
  }
  return { unit: frequency.unit, amount: frequency.interval };
}

// The next due date (noon) after completing a recurring item. "dueDate" counts
// from the current due date, "today" from today. Pass `timeZone` (the item's
// zone, else the workspace zone) so the browser and the UTC server agree;
// without it the runtime's local zone is used.
//
// `skipPast` (completions pass it): in "dueDate" mode an overdue item keeps
// its cadence but skips occurrences that are already past, landing on the
// first one after today (due Oct 20 every 4 days, completed Nov 1 -> Nov 5).
// Without it, "dueDate" mode ignores the clock and adds one step.
export function advanceRecurringDueDate(args: {
  dueAt: number;
  frequency: Exclude<RecurrenceFrequency, null>;
  mode: RecurringCompletionMode;
  now?: Date;
  timeZone?: string | null;
  skipPast?: boolean;
}) {
  const step = recurrenceStep(args.frequency);
  if (args.timeZone) {
    const timeZone = args.timeZone;
    const nowMs = (args.now ?? new Date()).getTime();
    const base: CalendarDate = zonedCalendarDate(args.mode === "today" ? nowMs : args.dueAt, timeZone);
    if (args.mode === "dueDate" && args.skipPast) {
      const today = zonedCalendarDate(nowMs, timeZone);
      const todayKey = calendarKey(today);
      // Multiples of the step from the original date, so month-end dates don't drift.
      for (let count = 1; count <= 100_000; count += 1) {
        const next = addCalendarUnits(base, step.unit, step.amount * count);
        if (calendarKey(next) > todayKey) return zonedNoon(next, timeZone);
      }
    }
    return zonedNoon(addCalendarUnits(base, step.unit, step.amount), timeZone);
  }

  const baseDate =
    args.mode === "today"
      ? getTodayReferenceDate(args.now)
      : toLocalNoon(new Date(args.dueAt));
  if (args.mode === "dueDate" && args.skipPast) {
    const base = { year: baseDate.getFullYear(), month: baseDate.getMonth() + 1, day: baseDate.getDate() };
    const nowDate = args.now ?? new Date();
    const todayKey = calendarKey({ year: nowDate.getFullYear(), month: nowDate.getMonth() + 1, day: nowDate.getDate() });
    for (let count = 1; count <= 100_000; count += 1) {
      const next = addCalendarUnits(base, step.unit, step.amount * count);
      if (calendarKey(next) > todayKey) return new Date(next.year, next.month - 1, next.day, 12).getTime();
    }
  }
  const nextDate = new Date(baseDate);
  switch (step.unit) {
    case "day":
      nextDate.setDate(nextDate.getDate() + step.amount);
      break;
    case "week":
      nextDate.setDate(nextDate.getDate() + step.amount * 7);
      break;
    case "month":
      nextDate.setMonth(nextDate.getMonth() + step.amount);
      break;
    case "year":
      nextDate.setFullYear(nextDate.getFullYear() + step.amount);
      break;
  }

  return toLocalNoon(nextDate).getTime();
}

export function advanceRecurringDueDateRange(args: {
  dueAt: number;
  dueEndAt: number | null;
  frequency: Exclude<RecurrenceFrequency, null>;
  mode: RecurringCompletionMode;
  now?: Date;
  timeZone?: string | null;
  skipPast?: boolean;
}) {
  const nextDueAt = advanceRecurringDueDate({
    dueAt: args.dueAt,
    frequency: args.frequency,
    mode: args.mode,
    now: args.now,
    timeZone: args.timeZone,
    skipPast: args.skipPast,
  });

  if (!args.dueEndAt || args.dueEndAt <= args.dueAt) {
    return {
      dueAt: nextDueAt,
      dueEndAt: null,
    };
  }

  return {
    dueAt: nextDueAt,
    dueEndAt: nextDueAt + (args.dueEndAt - args.dueAt),
  };
}
