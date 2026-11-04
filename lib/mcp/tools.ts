// The Flow MCP tools (docs/mcp.md). Each tool is a thin wrapper over the same
// Convex functions the app and the Flow CLI call, made with the agent's own
// access token. The server hides data dump exclusions from agent tokens and
// refuses writes that touch them (convex/lib/agentVisibility.ts); output uses
// the CLI's formatting (lib/flow), so links print readably and written links
// convert back to stored syntax.
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { toStoredLinkText, type LinkLookup } from "../flow/links";
import { displayText, outlineLine, outlineLines, parseRecurrence, parseTimeOfDay, resolveLinkLookup } from "../flow/format";
import {
  collectDescendantIds,
  dueEndProblem,
  findSectionNode,
  findStrayNodes,
  isNodeCompleted,
  isNodeLocked,
  kindChangeArgs,
  lastChildId,
  metaOf,
  outlineBatchEntries,
  primarySectionSlot,
  scheduleForDue,
  validateParent,
  type PageDoc,
  type TreeNode,
} from "../flow/logic";
import { isValidTimeZone, zonedCalendarDate, zonedNoon } from "../domain/timeZone";

export type FlowCalls = {
  query: (path: string, args?: Record<string, unknown>) => Promise<unknown>;
  mutation: (path: string, args?: Record<string, unknown>) => Promise<unknown>;
};

// A refusal the agent can act on (shown as the tool's error text).
export class ToolError extends Error {}
const refuse = (message: string): never => {
  throw new ToolError(message);
};

type PageTree = { page: PageDoc; nodes: TreeNode[]; loadWarning?: string | null };
type NodeDetail = {
  node: TreeNode & { priority?: string | null };
  page: PageDoc;
  ancestors: { _id: string; text: string; archived: boolean }[];
  nodes: TreeNode[];
  truncated: boolean;
};
type Settings = { timeZone: string | null; completionMode: "dueDate" | "today" | null };

const NOT_FOUND_ITEM = "Item not found (or it's excluded from data dumps, which agents can't see).";
const NOT_FOUND_PAGE = "Page not found (or it's excluded from data dumps, which agents can't see).";

// ---- reads ----

async function links(flow: FlowCalls, texts: string[]): Promise<LinkLookup | null> {
  try {
    return await resolveLinkLookup(texts, (path, args) => flow.query(path, args));
  } catch {
    return null;
  }
}

async function loadTree(flow: FlowCalls, pageId: string) {
  const tree = (await flow.query("workspace:getPageTree", { pageId })) as PageTree | null;
  return tree ?? refuse(NOT_FOUND_PAGE);
}

async function loadDetail(flow: FlowCalls, nodeId: string) {
  const detail = (await flow.query("workspace:getNodeDetail", { nodeId })) as NodeDetail | null;
  return detail ?? refuse(NOT_FOUND_ITEM);
}

async function settings(flow: FlowCalls): Promise<Settings> {
  try {
    return (await flow.query("workspace:getWorkspaceSettings")) as Settings;
  } catch {
    return { timeZone: null, completionMode: null };
  }
}

const zoneOf = (s: Settings) => (s.timeZone && isValidTimeZone(s.timeZone) ? s.timeZone : "UTC");

function formatDate(ms: number | null | undefined, timeZone: string) {
  if (!ms) return null;
  const { year, month, day } = zonedCalendarDate(ms, timeZone);
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function formatRecurrence(value: unknown) {
  if (!value) return null;
  if (typeof value === "string") return value;
  const { interval, unit } = value as { interval?: number; unit?: string };
  return interval && unit ? `every ${interval} ${unit}${interval === 1 ? "" : "s"}` : JSON.stringify(value);
}

export async function renderPage(flow: FlowCalls, pageId: string) {
  const tree = await loadTree(flow, pageId);
  const lookup = await links(flow, tree.nodes.map((node) => node.text));
  const lines = [`# ${tree.page.title}  (page ${tree.page._id})`, ...outlineLines(tree.nodes, lookup)];
  const strays = findStrayNodes(tree.nodes);
  if (strays.length) {
    lines.push("", `## Stray items (${strays.length}): active, but their parent is archived, missing or on another page`);
    for (const node of strays) {
      lines.push(outlineLine(node, 0, lookup));
      lines.push(...outlineLines(tree.nodes, lookup, node._id, 1));
    }
  }
  if (tree.loadWarning) lines.push("", `Note: ${tree.loadWarning}`);
  return lines.join("\n");
}

export async function renderItem(flow: FlowCalls, nodeId: string) {
  const detail = await loadDetail(flow, nodeId);
  const zone = zoneOf(await settings(flow));
  const { node, page } = detail;
  const meta = metaOf(node);
  const lookup = await links(flow, [node.text, ...detail.ancestors.map((a) => a.text), ...detail.nodes.map((n) => n.text)]);
  const fields: [string, unknown][] = [
    ["id", node._id],
    ["page", `${page.title} (${page._id})`],
    ["kind", node.kind],
    ["status", node.kind === "task" ? (node.taskStatus ?? "todo") : meta.noteCompleted === true ? "completed" : null],
    ["archived", node.archived || page.archived ? "yes" : null],
    ["due", formatDate(node.dueAt, node.dueTimeZone || zone)],
    ["due end", formatDate(node.dueEndAt, node.dueTimeZone || zone)],
    ["time", node.dueTime ? `${node.dueTime} ${node.dueTimeZone ?? ""}`.trim() : null],
    ["recurrence", formatRecurrence(meta.recurrenceFrequency)],
    ["recurrence basis", typeof meta.recurrenceBasis === "string" ? meta.recurrenceBasis : null],
    ["priority", node.priority ?? null],
  ];
  const lines = [`${displayText(node.text, lookup)}`];
  for (const [label, value] of fields) if (value !== null && value !== undefined) lines.push(`${label}: ${value}`);
  if (detail.ancestors.length) {
    lines.push("", "Path:");
    detail.ancestors.forEach((a, depth) => lines.push(`${"  ".repeat(depth)}- ${displayText(a.text, lookup)}  (${a._id})`));
  }
  const children = outlineLines(detail.nodes, lookup, node._id, 0);
  if (children.length) lines.push("", "Children:", ...children);
  if (detail.truncated) lines.push("", "Note: the item's subtree is large; only part of it is shown.");
  return lines.join("\n");
}

// ---- writes ----

// YYYY-MM-DD as noon in the workspace's time zone (UTC when it has none),
// like the app's date picker. "none" clears; undefined leaves it.
function parseDue(value: string | undefined, timeZone: string) {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return refuse(`Bad date "${value}"; use YYYY-MM-DD or none.`);
  const date = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const ms = zonedNoon(date, timeZone);
  const back = zonedCalendarDate(ms, timeZone);
  if (back.year !== date.year || back.month !== date.month || back.day !== date.day) refuse(`Bad date "${value}".`);
  return ms;
}

function parseTime(value: string | undefined, zone: string) {
  if (value === undefined) return {};
  let time: string | null;
  try {
    time = parseTimeOfDay(value);
  } catch (error) {
    return refuse((error as Error).message);
  }
  return time === null ? { dueTime: null, dueTimeZone: null } : { dueTime: time, dueTimeZone: zone };
}

function parseRecur(value: string | undefined) {
  try {
    return parseRecurrence(value);
  } catch (error) {
    return refuse((error as Error).message);
  }
}

function pickTimeZone(requested: string | undefined, s: Settings) {
  if (requested !== undefined && !isValidTimeZone(requested)) refuse(`Unknown time zone "${requested}"; use an IANA name like America/Los_Angeles.`);
  return requested ?? zoneOf(s);
}

type AddInput = {
  pageId: string;
  text: string;
  parentId?: string;
  afterId?: string;
  task?: boolean;
  due?: string;
  dueEnd?: string;
  time?: string;
  timeZone?: string;
};

export async function addItem(flow: FlowCalls, input: AddInput) {
  const s = await settings(flow);
  const zone = pickTimeZone(input.timeZone, s);
  const dueAt = parseDue(input.due, zone) ?? null;
  const dueEndAt = parseDue(input.dueEnd, zone) ?? null;
  if (input.time && dueAt === null) refuse("time needs a due date.");
  if (dueEndAt !== null) {
    const problem = dueEndProblem(dueEndAt, dueAt);
    if (problem) refuse(problem.replace("--due-end", "dueEnd").replace("--due", "due"));
  }
  const tree = await loadTree(flow, input.pageId);
  if (tree.page.archived) refuse("That page is archived.");
  const placed = input.parentId !== undefined || input.afterId !== undefined;
  if (!placed && primarySectionSlot(tree.page) === "requireParent") refuse("Planner pages need parentId (a day or section id from read_page).");
  let parent: string | null | undefined;
  let afterNodeId: string | null | undefined;
  if (input.afterId && input.afterId !== "top") {
    const after = tree.nodes.find((n) => n._id === input.afterId && !n.archived) ?? refuse("afterId must be an active item on this page.");
    if (input.parentId && after.parentNodeId !== input.parentId) refuse("afterId must be a child of parentId.");
    parent = after.parentNodeId;
    afterNodeId = input.afterId;
  } else if (input.parentId) {
    parent = input.parentId;
    afterNodeId = input.afterId === "top" ? null : (lastChildId(tree.nodes, input.parentId) ?? null);
  } else if (input.afterId === "top") {
    const slot = primarySectionSlot(tree.page);
    parent = slot === "root" || slot === "requireParent" ? null : (findSectionNode(tree.nodes, slot)?._id ?? null);
    afterNodeId = null;
  }
  if (parent) {
    const error = validateParent({ nodeId: null, parentId: parent, targetNodes: tree.nodes.filter((n) => !n.archived) });
    if (error) refuse(`parentId: ${error}`);
  }
  const isTask = Boolean(input.task) || dueAt !== null;
  const entry = {
    text: toStoredLinkText(input.text),
    ...(parent !== undefined ? { parentNodeId: parent } : {}),
    ...(afterNodeId !== undefined ? { afterNodeId } : {}),
    ...(isTask ? { kind: "task", taskStatus: "todo", lockKind: true } : {}),
    ...(dueAt !== null ? { dueAt, ...parseTime(input.time, zone) } : {}),
    ...(dueEndAt !== null ? { dueEndAt } : {}),
  };
  const created = (await flow.mutation("workspace:createNodesBatch", { pageId: input.pageId, nodes: [entry], parseDraft: true })) as { _id: string }[];
  return `Added ${created[0]?._id}.`;
}

export async function addOutline(flow: FlowCalls, input: { pageId: string; outline: string }) {
  const nodes = outlineBatchEntries(toStoredLinkText(input.outline));
  if (!nodes.length) refuse("No outline items found.");
  const tree = await loadTree(flow, input.pageId);
  if (tree.page.archived) refuse("That page is archived.");
  if (primarySectionSlot(tree.page) === "requireParent") refuse("Planner pages don't take outlines at the top level; use add_item with parentId.");
  const created = (await flow.mutation("workspace:createNodesBatch", { pageId: input.pageId, nodes })) as { _id: string }[];
  return `Added ${created.length} item${created.length === 1 ? "" : "s"}:\n${created.map((node) => node._id).join("\n")}`;
}

async function loadActive(flow: FlowCalls, nodeId: string) {
  const detail = await loadDetail(flow, nodeId);
  if (detail.node.archived) refuse("That item is archived.");
  if (detail.page.archived) refuse("That item is on an archived page.");
  return detail;
}

export async function updateItem(flow: FlowCalls, input: { nodeId: string; text?: string; priority?: string; kind?: "task" | "note" }) {
  if (input.text === undefined && input.priority === undefined && input.kind === undefined) refuse("Nothing to update.");
  const { node } = await loadActive(flow, input.nodeId);
  const args: Record<string, unknown> = { nodeId: input.nodeId };
  if (input.kind !== undefined) {
    if (isNodeLocked(node)) refuse("Section headers and planner days can't change kind.");
    Object.assign(args, kindChangeArgs(node, input.kind));
  }
  if (input.text !== undefined) {
    if (!input.text.trim()) refuse("Text can't be empty.");
    Object.assign(args, { text: toStoredLinkText(input.text, node.text), parseDraft: true });
  }
  if (input.priority !== undefined) args.priority = input.priority === "none" ? null : input.priority;
  await flow.mutation("workspace:updateNode", args);
  return "Updated.";
}

type ScheduleInput = {
  nodeId: string;
  due?: string;
  dueEnd?: string;
  time?: string;
  timeZone?: string;
  recurrence?: string;
  recurrenceBasis?: "dueDate" | "today" | "none";
};

export async function scheduleItem(flow: FlowCalls, input: ScheduleInput) {
  const { nodeId } = input;
  if ([input.due, input.dueEnd, input.time, input.recurrence, input.recurrenceBasis].every((value) => value === undefined)) refuse("Nothing to change.");
  const s = await settings(flow);
  const { node } = await loadActive(flow, nodeId);
  const zone = pickTimeZone(input.timeZone, s);
  const dateZone = node.dueTimeZone || zone;
  const dueAt = parseDue(input.due, dateZone);
  const dueEndAt = parseDue(input.dueEnd, dateZone);
  const recur = parseRecur(input.recurrence);
  const setsTime = input.time !== undefined && input.time !== "none";
  const setsRecur = recur !== undefined && recur !== null;
  if (node.kind !== "task" && (setsTime || setsRecur || (input.recurrenceBasis && input.recurrenceBasis !== "none"))) {
    refuse("Times and recurrence are for tasks; this is a note. Use update_item with kind \"task\" first.");
  }
  const effectiveDueAt = dueAt !== undefined ? dueAt : (node.dueAt ?? null);
  if (setsTime && effectiveDueAt === null) refuse("time needs a due date (pass due, or set one first).");
  if (dueEndAt !== undefined) {
    const problem = dueEndProblem(dueEndAt, effectiveDueAt);
    if (problem) refuse(problem.replace("--due-end", "dueEnd").replace("--due", "due"));
  }
  const args: Record<string, unknown> = { nodeId };
  if (dueAt !== undefined) Object.assign(args, scheduleForDue(dueAt, { dueEndAt: node.dueEndAt }));
  if (dueEndAt !== undefined) args.dueEndAt = dueEndAt;
  // A time keeps the item's own time zone when it has one.
  Object.assign(args, parseTime(input.time, input.timeZone ?? (node.dueTimeZone || zone)));
  if (recur !== undefined) args.recurrenceFrequency = recur;
  if (Object.keys(args).length > 1) await flow.mutation("workspace:updateNode", args);
  if (input.recurrenceBasis) {
    await flow.mutation("workspace:setRecurrenceBasis", { nodeId, basis: input.recurrenceBasis === "none" ? null : input.recurrenceBasis });
  }
  return "Scheduled.";
}

const ROUTE_LABELS: Record<string, string> = {
  planner: "planner item (Past Weeks flow)",
  plannerPreview: "planner copy of this task",
  taskPage: "task page with a Done archive (moved to Done)",
  recurring: "recurring task, rolled forward to the next due date",
  task: "task marked done",
  note: "note marked completed",
};

export async function completeItem(flow: FlowCalls, input: { nodeId: string; mode?: "dueDate" | "today" }) {
  const s = await settings(flow);
  const completionMode = input.mode ?? s.completionMode ?? "dueDate";
  const detail = await loadDetail(flow, input.nodeId);
  if (detail.node.archived) return "That item is archived (completed planner and task-page items are); nothing changed.";
  if (detail.page.archived) refuse("That item is on an archived page.");
  if (isNodeCompleted(detail.node)) return "Already done; nothing changed.";
  const result = (await flow.mutation("workspace:setNodeCompletion", {
    nodeId: input.nodeId,
    intent: "complete",
    completionMode,
    expectedRevision: detail.node.revision ?? 0,
  })) as { status: string; route: string; receiptId?: string | null };
  if (result.status === "stale") refuse("The item changed since it was read; nothing changed. Try again.");
  if (result.status === "noop") return "Already done; nothing changed.";
  const how = `Completed: ${ROUTE_LABELS[result.route] ?? result.route} (mode ${completionMode}).`;
  return result.receiptId ? `${how}\nUndo receipt: ${result.receiptId} (pass it to undo_complete)` : how;
}

export async function undoComplete(flow: FlowCalls, input: { receiptId: string }) {
  await flow.mutation("workspace:undoCompletion", { receiptIds: [input.receiptId] });
  return "Undone.";
}

export async function moveItem(flow: FlowCalls, input: { nodeId: string; pageId?: string; parentId?: string; afterId?: string }) {
  if (!input.pageId && input.parentId === undefined && input.afterId === undefined) refuse("Say where to move it: pageId, parentId or afterId.");
  const { node } = await loadActive(flow, input.nodeId);
  if (isNodeLocked(node)) refuse("Section headers and planner days can't be moved.");
  const sourceTree = await loadTree(flow, node.pageId);
  const targetPageId = input.pageId ?? node.pageId;
  const crossPage = targetPageId !== node.pageId;
  if (!crossPage && input.parentId === undefined && input.afterId === undefined) refuse("It's already on that page; pass parentId or afterId.");
  const target = crossPage ? await loadTree(flow, targetPageId) : sourceTree;
  if (target.page.archived) refuse("The destination page is archived.");
  const targetNodes = target.nodes.filter((n) => !n.archived);
  const descendants = collectDescendantIds(sourceTree.nodes, input.nodeId);
  let parent: string | null | undefined = input.parentId === undefined ? undefined : input.parentId === "root" ? null : input.parentId;
  let afterNodeId: string | null | undefined;
  if (input.afterId === "top") {
    afterNodeId = null;
  } else if (input.afterId) {
    if (input.afterId === input.nodeId || descendants.has(input.afterId)) refuse("afterId can't be the item itself or something inside it.");
    const after = targetNodes.find((n) => n._id === input.afterId) ?? refuse("afterId must be an active item on the destination page.");
    if (parent !== undefined && after.parentNodeId !== parent) refuse("afterId must be a child of parentId.");
    parent = after.parentNodeId;
    afterNodeId = input.afterId;
  }
  const error = validateParent({ nodeId: input.nodeId, parentId: parent ?? null, targetNodes, descendantIds: descendants });
  if (error) refuse(`parentId: ${error}`);
  await flow.mutation("workspace:moveNodeTree", {
    nodeIds: [input.nodeId],
    pageId: targetPageId,
    parentNodeId: parent === undefined ? (crossPage ? null : node.parentNodeId) : parent,
    ...(afterNodeId !== undefined ? { afterNodeId } : {}),
  });
  return "Moved.";
}

export async function listPages(flow: FlowCalls) {
  const pages = (await flow.query("workspace:listPages")) as PageDoc[];
  if (!pages.length) return "No pages.";
  return pages.map((page) => `${page._id}  ${page.title}`).join("\n");
}

export async function search(flow: FlowCalls, input: { query: string; limit?: number }) {
  type Result = {
    pages: PageDoc[];
    nodes: { node: TreeNode; page: PageDoc | null; parentNode: TreeNode | null }[];
  };
  const result = (await flow.query("workspace:searchLinkTargets", { query: input.query, limit: input.limit ?? 12 })) as Result;
  const lookup = await links(flow, result.nodes.flatMap((entry) => [entry.node.text, ...(entry.parentNode ? [entry.parentNode.text] : [])]));
  const lines: string[] = [];
  if (result.pages.length) {
    lines.push("Pages:");
    for (const page of result.pages) lines.push(`- ${page.title}  (page ${page._id})${page.archived ? " (archived)" : ""}`);
  }
  if (result.nodes.length) {
    lines.push(...(lines.length ? [""] : []), "Items:");
    for (const { node, page, parentNode } of result.nodes) {
      const under = parentNode ? ` under "${displayText(parentNode.text, lookup).slice(0, 60)}"` : "";
      lines.push(`- ${displayText(node.text, lookup)}  (${node._id}) on "${page?.title ?? "?"}" (page ${node.pageId})${under}`);
    }
  }
  return lines.length ? lines.join("\n") : "No matches.";
}

// ---- registration ----

const id = (what: string) => z.string().min(1).describe(what);
const LINKS_NOTE =
  "Links print as [target text](node:ID) or [Page title](page:ID); a labeled link prints as [Label → target](node:ID). " +
  "Write links the same way (or as [[node:ID]] / [[page:ID]]) and they are stored as links.";

type Handler<T> = (flow: FlowCalls, input: T) => Promise<string>;

export function registerFlowTools(server: McpServer, flow: FlowCalls, onError: (error: unknown) => string) {
  const run = <T>(handler: Handler<T>) => async (input: T) => {
    try {
      return { content: [{ type: "text" as const, text: await handler(flow, input) }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: onError(error) }], isError: true };
    }
  };
  const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const write = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description: "List the workspace's active pages as `<pageId>  <title>`. Journal pages are titled YYYY-MM-DD. Start here to find a page id.",
      inputSchema: {},
      annotations: read,
    },
    run(async (f) => listPages(f)),
  );
  server.registerTool(
    "read_page",
    {
      title: "Read a page",
      description:
        "Print a page's outline: one line per active item, indented by nesting, with `[ ]`/`[x]` for tasks and each item's id in parentheses. " +
        LINKS_NOTE,
      inputSchema: { pageId: id("Page id from list_pages or search.") },
      annotations: read,
    },
    run((f, input: { pageId: string }) => renderPage(f, input.pageId)),
  );
  server.registerTool(
    "show_item",
    {
      title: "Show an item",
      description:
        "Show one item: its text, page, kind, status, due date, time, recurrence and priority, the path of parents above it, and its children. " +
        LINKS_NOTE,
      inputSchema: { nodeId: id("Item id (from read_page, search or a node:ID link).") },
      annotations: read,
    },
    run((f, input: { nodeId: string }) => renderItem(f, input.nodeId)),
  );
  server.registerTool(
    "search",
    {
      title: "Search",
      description: "Find pages by title and items by text (fuzzy, like the app's link search). Returns ids you can pass to read_page or show_item.",
      inputSchema: {
        query: z.string().min(1).describe("Words to look for."),
        limit: z.number().int().min(1).max(24).optional().describe("Most results per kind (default 12, max 24)."),
      },
      annotations: read,
    },
    run(search),
  );
  server.registerTool(
    "add_item",
    {
      title: "Add an item",
      description:
        "Add one item (note or task) to a page. By default it goes at the end of the page's main section (task pages: the page's top level). " +
        "Text is read like the app's editor: a leading `[ ] ` makes an open task, `[x] ` a done task. A due date makes it a task. " +
        LINKS_NOTE +
        " Returns the new item's id.",
      inputSchema: {
        pageId: id("Page to add to."),
        text: z.string().min(1).describe("The item's text."),
        parentId: z.string().optional().describe("Nest under this item (appends after its last child)."),
        afterId: z.string().optional().describe('Place right after this item (and under its parent), or "top" to put it first.'),
        task: z.boolean().optional().describe("Make it a task."),
        due: z.string().optional().describe("Due date, YYYY-MM-DD (makes it a task)."),
        dueEnd: z.string().optional().describe("End date for a range, YYYY-MM-DD, after the due date."),
        time: z.string().optional().describe("Time of day, 24-hour HH:MM (needs due)."),
        timeZone: z.string().optional().describe("IANA time zone for the date and time; default: the workspace's."),
      },
      annotations: write,
    },
    run(addItem),
  );
  server.registerTool(
    "add_outline",
    {
      title: "Add an outline",
      description:
        "Append several items at once, parsed like the app's importer: one item per line, nesting by two-space indent, " +
        "`[ ]`/`[x]` for tasks, and due markers at the end of a line like `!(2026-12-01)`, `!(2026-12-10 - 2026-12-14)` or `!(2026-12-01 | 1w)` " +
        "(a line with a due marker is a task). Goes where add_item would by default. " +
        LINKS_NOTE,
      inputSchema: {
        pageId: id("Page to add to."),
        outline: z.string().min(1).describe("The outline, e.g. \"- Plan trip\\n  - [ ] Book flights !(2026-12-01)\"."),
      },
      annotations: write,
    },
    run(addOutline),
  );
  server.registerTool(
    "update_item",
    {
      title: "Update an item",
      description:
        "Change an item's text, priority or kind. Text replaces the whole text; links copied from read_page output keep their exact stored form. " +
        "Changing kind resets status and schedule, like the app's toggle. To complete a task use complete_item; for dates use schedule_item. " +
        LINKS_NOTE,
      inputSchema: {
        nodeId: id("Item to change."),
        text: z.string().optional().describe("New text."),
        priority: z.enum(["low", "medium", "high", "none"]).optional().describe("Priority; none clears it."),
        kind: z.enum(["task", "note"]).optional().describe("Make it a task or a note."),
      },
      annotations: write,
    },
    run(updateItem),
  );
  server.registerTool(
    "schedule_item",
    {
      title: "Schedule an item",
      description:
        "Set or clear a task's due date, end date, time and recurrence, and its own completion basis. " +
        "due \"none\" clears the whole schedule. recurrence: daily, weekly, monthly, yearly, <n>d, <n>w, <n>m, <n>y (e.g. 2w), or none. " +
        "recurrenceBasis is the schedule panel's \"When this task is completed\": dueDate advances from the due date, today from the day it's completed, none uses the workspace setting.",
      inputSchema: {
        nodeId: id("Task to schedule."),
        due: z.string().optional().describe("YYYY-MM-DD, or none."),
        dueEnd: z.string().optional().describe("End date YYYY-MM-DD after the due date, or none."),
        time: z.string().optional().describe("24-hour HH:MM, or none."),
        timeZone: z.string().optional().describe("IANA time zone for a new date or time; default: the item's, else the workspace's."),
        recurrence: z.string().optional().describe("daily|weekly|monthly|yearly|<n>d|<n>w|<n>m|<n>y|none."),
        recurrenceBasis: z.enum(["dueDate", "today", "none"]).optional().describe("This task's completion basis."),
      },
      annotations: { ...write, idempotentHint: true },
    },
    run(scheduleItem),
  );
  server.registerTool(
    "complete_item",
    {
      title: "Complete an item",
      description:
        "Complete an item exactly like the app's checkbox: planner items move to Past Weeks, root tasks on task pages with a Done archive move to Done, " +
        "recurring tasks roll forward to their next due date, other tasks are marked done and notes marked completed. Never reopens. " +
        "Returns an undo receipt id for undo_complete.",
      inputSchema: {
        nodeId: id("Item to complete."),
        mode: z.enum(["dueDate", "today"]).optional().describe("How a recurring task without its own basis rolls forward; default: the workspace setting."),
      },
      annotations: write,
    },
    run(completeItem),
  );
  server.registerTool(
    "undo_complete",
    {
      title: "Undo a completion",
      description:
        "Undo a complete_item using its receipt id, the same checked undo as the app's Cmd+Z. Refused, with what changed, if anything the completion touched has changed since.",
      inputSchema: { receiptId: id("Receipt id from complete_item.") },
      annotations: { ...write, destructiveHint: true },
    },
    run(undoComplete),
  );
  server.registerTool(
    "move_item",
    {
      title: "Move an item",
      description:
        "Move an item and its whole branch (children, links and favorites come along). Give pageId to move to another page, " +
        'parentId to nest it (or "root" for the top level), and/or afterId for the exact spot ("top" = first). Appends at the end by default.',
      inputSchema: {
        nodeId: id("Item to move."),
        pageId: z.string().optional().describe("Destination page (default: its own page)."),
        parentId: z.string().optional().describe('New parent on the destination page, or "root".'),
        afterId: z.string().optional().describe('Place after this item, or "top".'),
      },
      annotations: write,
    },
    run(moveItem),
  );
}

export const FLOW_TOOL_NAMES = [
  "list_pages",
  "read_page",
  "show_item",
  "search",
  "add_item",
  "add_outline",
  "update_item",
  "schedule_item",
  "complete_item",
  "undo_complete",
  "move_item",
] as const;
