import { extractTags } from "./tags";
import {
  replaceNodeLinkMarkupWithResolvedText,
  replaceLinkMarkupWithLabels,
} from "./links";
import { timestampToDateInputValue } from "./recurrence";

export type TaskCalendarFeedEvent = {
  uid: string;
  summary: string;
  description?: string;
  dueAt: number;
  dueEndAt?: number | null;
  dueTime?: string | null;
  dueTimeZone?: string | null;
  updatedAt: number;
  categories?: string[];
};

export type TaskCalendarFeed = {
  calendarName: string;
  calendarDescription?: string;
  events: TaskCalendarFeedEvent[];
};

function escapeIcsText(value: string) {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n/g, "\\n")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function foldIcsLine(line: string) {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < line.length) {
    const limit = cursor === 0 ? 75 : 74;
    const slice = line.slice(cursor, cursor + limit);
    chunks.push(cursor === 0 ? slice : ` ${slice}`);
    cursor += limit;
  }

  return chunks;
}

function formatUtcIcsTimestamp(timestamp: number) {
  const date = new Date(timestamp);
  const year = `${date.getUTCFullYear()}`;
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  const hours = `${date.getUTCHours()}`.padStart(2, "0");
  const minutes = `${date.getUTCMinutes()}`.padStart(2, "0");
  const seconds = `${date.getUTCSeconds()}`.padStart(2, "0");
  return `${year}${month}${day}T${hours}${minutes}${seconds}Z`;
}

function addLocalDays(timestamp: number, dayCount: number) {
  const date = new Date(timestamp);
  return new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + dayCount,
    12,
    0,
    0,
    0,
  ).getTime();
}

function formatIcsDateValue(timestamp: number) {
  return timestampToDateInputValue(timestamp).replaceAll("-", "");
}

function getTimeZoneParts(timestamp: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
  const part = (type: string) => Number(parts.find((value) => value.type === type)?.value);
  return {
    year: part("year"),
    month: part("month"),
    day: part("day"),
    hour: part("hour"),
    minute: part("minute"),
  };
}

function getTimedEventStart(dateTimestamp: number, time: string, timeZone: string) {
  const [hour, minute] = time.split(":").map(Number);
  const { year, month, day } = getTimeZoneParts(dateTimestamp, timeZone);
  const wallTimestamp = Date.UTC(year, month - 1, day, hour, minute);
  let timestamp = wallTimestamp;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = getTimeZoneParts(timestamp, timeZone);
    const currentWallTimestamp = Date.UTC(
      current.year, current.month - 1, current.day, current.hour, current.minute,
    );
    const adjustment = wallTimestamp - currentWallTimestamp;
    timestamp += adjustment;
    if (adjustment === 0) {
      break;
    }
  }
  return timestamp;
}

export function normalizeCalendarTaskText(text: string) {
  return replaceLinkMarkupWithLabels(text)
    .replace(/^\s*#{1,6}\s+/g, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCalendarTaskTextWithNodeLinks(
  text: string,
  nodeTextById: ReadonlyMap<string, string>,
) {
  return normalizeCalendarTaskText(
    replaceNodeLinkMarkupWithResolvedText(text, nodeTextById),
  );
}

export function extractCalendarTaskCategories(text: string) {
  return extractTags(text).map((tag) => tag.toLowerCase());
}

export function buildTaskCalendarIcs(feed: TaskCalendarFeed) {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "PRODID:-//Malesh Labs//MaleshFlow//EN",
    `X-WR-CALNAME:${escapeIcsText(feed.calendarName)}`,
  ];

  if (feed.calendarDescription) {
    lines.push(`X-WR-CALDESC:${escapeIcsText(feed.calendarDescription)}`);
  }

  const sortedEvents = [...feed.events].sort((left, right) => {
    if (left.dueAt !== right.dueAt) {
      return left.dueAt - right.dueAt;
    }

    return left.summary.localeCompare(right.summary);
  });

  for (const event of sortedEvents) {
    const dueEndAt =
      event.dueEndAt && event.dueEndAt > event.dueAt ? event.dueEndAt : event.dueAt;
    const exclusiveEnd = addLocalDays(dueEndAt, 1);
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${escapeIcsText(event.uid)}`);
    lines.push(`DTSTAMP:${formatUtcIcsTimestamp(event.updatedAt)}`);
    lines.push(`LAST-MODIFIED:${formatUtcIcsTimestamp(event.updatedAt)}`);
    lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
    let timedRange: { start: number; end: number } | null = null;
    if (event.dueTime && /^([01]\d|2[0-3]):[0-5]\d$/.test(event.dueTime) && event.dueTimeZone) {
      try {
        const start = getTimedEventStart(event.dueAt, event.dueTime, event.dueTimeZone);
        const end = dueEndAt > event.dueAt
          ? getTimedEventStart(dueEndAt, event.dueTime, event.dueTimeZone) + 60 * 60 * 1000
          : start + 60 * 60 * 1000;
        timedRange = { start, end };
      } catch {
        // Invalid stored time zones should not break the entire subscribed feed.
      }
    }
    if (timedRange) {
      lines.push(`DTSTART:${formatUtcIcsTimestamp(timedRange.start)}`);
      lines.push(`DTEND:${formatUtcIcsTimestamp(timedRange.end)}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${formatIcsDateValue(event.dueAt)}`);
      lines.push(`DTEND;VALUE=DATE:${formatIcsDateValue(exclusiveEnd)}`);
    }

    if (event.description) {
      lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    }

    if (event.categories && event.categories.length > 0) {
      lines.push(`CATEGORIES:${event.categories.map(escapeIcsText).join(",")}`);
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  return lines.flatMap(foldIcsLine).join("\r\n") + "\r\n";
}
