// MaleshFlow CLI: read and change workspace data through the same Convex
// functions the app uses (so links, embeddings and AI hooks still run).
// Usage and examples: docs/flow-cli.md, or `npm run -s flow -- help`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { advanceRecurringDueDateRange, parseRecurrenceFrequency } from "../lib/domain/recurrence";
import {
  SIDEBAR_SECTIONS,
  classifyStrayParent,
  collectDescendantIds,
  createPageArgs,
  findSectionNode,
  findStrayNodes,
  getPageMeta,
  isNodeCompleted,
  isNodeLocked,
  isPlannerCompletionItem,
  isUntypedSectionPage,
  kindChangeArgs,
  metaOf,
  nodeChecks,
  parseDueDate,
  primarySectionSlot,
  scheduleForDue,
  validateParent,
  type DoctorFinding,
  type PageDoc,
  type SidebarSection,
  type TreeNode,
} from "./flowLogic";

type Spec = { args: string[]; optional?: string[]; flags?: string[]; usage: string };

const GLOBAL_FLAGS = ["prod", "yes", "dry-run", "json"];
const BOOLEAN_FLAGS = new Set([...GLOBAL_FLAGS, "task", "note"]);
const COMMANDS: Record<string, Spec> = {
  pages: { args: [], usage: "pages                                  List pages (id, title)" },
  tree: {
    args: ["pageId"],
    usage: "tree <pageId>                          Print a page outline with node ids (and any stray items)",
  },
  "add-page": {
    args: ["title..."],
    flags: ["section", "type"],
    usage: "add-page <title> [--section Tasks] [--type planner]\n                                         Create a page the way the app's sidebar + button does",
  },
  "rename-page": { args: ["pageId", "title..."], usage: "rename-page <pageId> <title>           Rename a page" },
  add: {
    args: ["pageId", "text..."],
    flags: ["parent", "after", "task", "due", "time"],
    usage:
      "add <pageId> <text> [--parent id] [--after id|top] [--task] [--due YYYY-MM-DD [--time HH:MM]]\n" +
      "                                         Add a node (end of the page's main section by default)",
  },
  "add-outline": {
    args: ["pageId", "file"],
    usage: "add-outline <pageId> <file|->          Append a markdown outline in one batch",
  },
  update: {
    args: ["nodeId"],
    flags: ["text", "status", "due", "time", "priority", "recur", "task", "note", "mode"],
    usage:
      "update <nodeId> [--text t] [--status todo|done] [--due YYYY-MM-DD|none]\n" +
      "                [--time HH:MM|none] [--priority low|medium|high|none]\n" +
      "                [--recur daily|weekly|monthly|yearly|<n>d|<n>w|<n>m|<n>y|none] [--task|--note]",
  },
  done: {
    args: ["nodeId"],
    flags: ["mode"],
    usage:
      "done <nodeId> [--mode dueDate|today]   Complete an item the way the app's checkbox does\n" +
      "                                         (planner -> Past Weeks, task pages -> Done, recurring rolls forward)",
  },
  move: {
    args: ["nodeId"],
    flags: ["page", "parent", "after"],
    usage:
      "move <nodeId> [--page id] [--parent id|root] [--after id|top]\n" +
      "                                         Move a node and its whole branch; appends by default",
  },
  archive: { args: ["nodeId"], usage: "archive <nodeId>                       Archive (hide) a node and its branch" },
  unarchive: { args: ["nodeId"], usage: "unarchive <nodeId>                     Restore an archived node and its branch" },
  doctor: {
    args: [],
    flags: ["limit"],
    usage: "doctor [--limit 5]                     Read-only data check (stray items, untyped pages, bad schedules)",
  },
  run: {
    args: ["query|mutation", "module:fn"],
    optional: ["json"],
    usage: "run <query|mutation> <module:fn> [json] Call a public query or mutation (ownerKey added)",
  },
};

const HELP = `Usage: npm run -s flow -- <command> [args] [flags]

Commands:
${Object.values(COMMANDS)
  .map((spec) => `  ${spec.usage}`)
  .join("\n")}

Flags: --prod (production; writes also need --yes), --dry-run (print the writes, don't send),
       --json (raw output for pages/tree/doctor). Docs: docs/flow-cli.md`;

function fail(message: string): never {
  console.error(message);
  return process.exit(1);
}

// ---- argument parsing (all checks happen before any network call) ----
const argv = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "-h" || arg === "--help") {
    flags.help = true;
  } else if (arg.startsWith("--")) {
    const name = arg.slice(2);
    if (BOOLEAN_FLAGS.has(name)) {
      flags[name] = true;
    } else {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value.`);
      flags[name] = value;
      i++;
    }
  } else {
    positional.push(arg);
  }
}
const [command, ...rest] = positional;

if (!command || command === "help" || flags.help) {
  console.log(HELP);
  process.exit(0);
}
const spec = COMMANDS[command] ?? fail(`Unknown command "${command}". Run with "help" to list commands.`);
for (const name of Object.keys(flags)) {
  if (!GLOBAL_FLAGS.includes(name) && !spec.flags?.includes(name)) {
    fail(`Unknown flag --${name} for "${command}".\nUsage: ${spec.usage}`);
  }
}
const required = spec.args.length;
const variadic = spec.args.at(-1)?.endsWith("...");
const maxArgs = variadic ? Infinity : required + (spec.optional?.length ?? 0);
if (rest.length < required || rest.length > maxArgs) {
  fail(`Wrong number of arguments for "${command}".\nUsage: ${spec.usage}`);
}
const str = (name: string) => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
const oneOf = <T extends string>(name: string, allowed: readonly T[]) => {
  const value = str(name);
  if (value !== undefined && !allowed.includes(value as T)) fail(`--${name} must be one of: ${allowed.join(", ")}`);
  return value as T | undefined;
};
const prod = Boolean(flags.prod);
const dryRun = Boolean(flags["dry-run"]);

function parseDue(value: string | undefined) {
  try {
    return parseDueDate(value);
  } catch (error) {
    return fail((error as Error).message);
  }
}

function parseTime(value: string | undefined) {
  if (value === undefined) return {};
  if (value === "none") return { dueTime: null, dueTimeZone: null };
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) fail(`Bad time "${value}"; use 24-hour HH:MM or none.`);
  return { dueTime: value, dueTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}

function parseRecur(value: string | undefined) {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  if (["daily", "weekly", "monthly", "yearly"].includes(value)) return value;
  const match = value.match(/^(\d+)([dwmy])$/);
  if (!match || Number(match[1]) < 1) fail(`Bad --recur "${value}"; use daily|weekly|monthly|yearly, <n>d|w|m|y, or none.`);
  const unit = { d: "day", w: "week", m: "month", y: "year" }[match[2] as "d" | "w" | "m" | "y"];
  return { interval: Number(match[1]), unit };
}

// ---- connection (created only once a valid command needs it) ----
function deploymentUrl() {
  if (prod) return process.env.MALESHFLOW_PROD_URL ?? "https://precise-coyote-972.convex.cloud";
  let env = "";
  try {
    env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  } catch {
    fail("No .env.local found. Run `npx convex dev --once` to create it, or use --prod.");
  }
  return env.match(/^NEXT_PUBLIC_CONVEX_URL=(\S+)/m)?.[1] ?? fail("NEXT_PUBLIC_CONVEX_URL missing from .env.local.");
}

function readOwnerKey() {
  if (process.env.MALESHFLOW_OWNER_KEY) return process.env.MALESHFLOW_OWNER_KEY;
  try {
    const out = execFileSync("npx", ["convex", "env", "get", "OWNER_ACCESS_TOKEN", ...(prod ? ["--prod"] : [])], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) return out;
  } catch {
    // fall through to the message below
  }
  return fail(
    "Could not read OWNER_ACCESS_TOKEN. Run `npx convex login` (and check the token is set with " +
      `\`npx convex env list${prod ? " --prod" : ""}\`), or set MALESHFLOW_OWNER_KEY.`,
  );
}

let connection: { client: ConvexHttpClient; key: string } | undefined;
function connect() {
  connection ??= { client: new ConvexHttpClient(deploymentUrl()), key: readOwnerKey() };
  return connection;
}
const fn = (path: string) => {
  const [mod, name] = path.split(":");
  if (!mod || !name) fail(`Function must look like module:name, got "${path}".`);
  return anyApi[mod][name];
};
const query = (path: string, args: object = {}) => {
  const { client, key } = connect();
  return client.query(fn(path), { ownerKey: key, ...args });
};
// --dry-run prints each write instead of sending it and carries on, so a
// command that makes two writes shows both. It is not validated by the
// backend, and it still reads live data first (to check ids and find where to
// append).
const mutation = async (path: string, args: object = {}): Promise<unknown> => {
  if (dryRun) {
    console.log(`[dry-run] ${path} ${JSON.stringify(args, null, 2)}`);
    return `<result of ${path}>`;
  }
  if (prod && !flags.yes) fail("Refusing to write to production without --yes (try --dry-run first).");
  const { client, key } = connect();
  return client.mutation(fn(path), { ownerKey: key, ...args });
};
const print = (value: unknown) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));
const ok = (value?: unknown) => (dryRun ? console.log("(dry run: nothing was sent)") : print(value ?? "ok"));

// ---- reads ----
type PageTree = { page: PageDoc; nodes: TreeNode[]; loadWarning?: string | null };
type NodeInfo = { nodeId: string; pageId: string | null; archived: boolean; pageArchived: boolean; parentNodeId: string | null; parentArchived: boolean };

async function loadTree(pageId: string) {
  const result = (await query("workspace:getPageTree", { pageId })) as PageTree | null;
  return result ?? fail("Page not found.");
}

async function resolveNodes(nodeIds: string[]) {
  const infos = (await query("workspace:resolveNodeLinks", { nodeIds })) as NodeInfo[];
  return new Map(infos.map((info) => [info.nodeId, info]));
}

// An active node with its page and that page's active tree.
async function loadActiveNode(nodeId: string) {
  const info = (await resolveNodes([nodeId])).get(nodeId);
  if (!info?.pageId) fail("Node not found.");
  if (info.archived) fail("That item is archived. Unarchive it first.");
  if (info.pageArchived) fail("That item is on an archived page, which the app doesn't edit.");
  const tree = await loadTree(info.pageId);
  const node = tree.nodes.find((n) => n._id === nodeId) ?? fail("Node not found in its page tree (the page may be too large to load).");
  return { node, page: tree.page, nodes: tree.nodes };
}

// Last active child under `parent`, so new items append instead of landing on top.
function lastChildId(nodes: TreeNode[], parent: string | null, exclude?: string) {
  const siblings = nodes.filter((n) => !n.archived && n.parentNodeId === parent && n._id !== exclude);
  siblings.sort((a, b) => a.position - b.position);
  return siblings.at(-1)?._id ?? null;
}

// Picks the same completion path as the app's task checkbox
// (toggleSelectedNodesCompletion in components/WorkspaceApp.tsx). Never reopens:
// an item that is already done is left alone.
async function completeLikeApp(nodeId: string) {
  const completionMode = oneOf("mode", ["dueDate", "today"] as const) ?? "dueDate";
  const info = (await resolveNodes([nodeId])).get(nodeId);
  if (info?.archived) {
    // Completed planner and task-page items are archived (Past Weeks / Done).
    return console.log("That item is archived (completed planner and task-page items are); nothing changed.");
  }
  const { node, page, nodes } = await loadActiveNode(nodeId);
  if (isNodeCompleted(node)) return console.log("Already done; nothing changed.");
  const nodeMap = new Map(nodes.map((n) => [n._id, n]));
  const pageMeta = metaOf(page);
  const isSidebarPage = pageMeta.specialPage === "sidebar";
  const isTaskPage = !isSidebarPage && getPageMeta(page).pageType === "task";

  if (isPlannerCompletionItem(node, nodeMap)) {
    // Planner day/focus items: completing the last open item archives the day to Past Weeks.
    console.error(`Planner item on "${page.title}": using planner:completePlannerTask.`);
    await mutation("planner:completePlannerTask", { plannerNodeId: nodeId, completionMode });
    return ok();
  }
  if (node.kind !== "task") fail("Only tasks (or planner items) can be completed. Use update --task first.");
  if (isTaskPage && pageMeta.archiveCompletedRootTasksToDone === true) {
    console.error(`Task page "${page.title}": using workspace:completeTaskPageTask.`);
    await mutation("workspace:completeTaskPageTask", { nodeId, completionMode });
    return ok();
  }
  const frequency = parseRecurrenceFrequency(metaOf(node).recurrenceFrequency);
  if (frequency !== null && node.dueAt) {
    const next = advanceRecurringDueDateRange({ dueAt: node.dueAt, dueEndAt: node.dueEndAt ?? null, frequency, mode: completionMode });
    console.error(`Recurring task: rolling forward to the next due date (mode ${completionMode}).`);
    await mutation("workspace:updateNode", { nodeId, kind: "task", lockKind: true, taskStatus: "todo", dueAt: next.dueAt, dueEndAt: next.dueEndAt });
    return ok();
  }
  await mutation("workspace:updateNode", { nodeId, kind: "task", lockKind: true, taskStatus: "done" });
  return ok();
}

function parseOutline(markdown: string) {
  const entries: Record<string, unknown>[] = [];
  const stack: { indent: number; clientId: string }[] = [];
  const lastChildByParent = new Map<string, string>();
  markdown.split("\n").forEach((line, index) => {
    const match = line.match(/^(\s*)[-*]\s+(?:\[( |x|X)\]\s+)?(.*)$/);
    if (!match) return;
    const indent = match[1].replace(/\t/g, "  ").length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const clientId = `c${index}`;
    const parent = stack.at(-1)?.clientId;
    const previous = lastChildByParent.get(parent ?? "root");
    entries.push({
      clientId,
      text: match[3].trim(),
      ...(parent ? { parentClientId: parent } : {}),
      ...(previous ? { afterClientId: previous } : {}),
      ...(match[2] !== undefined ? { kind: "task", taskStatus: match[2] === " " ? "todo" : "done" } : {}),
    });
    lastChildByParent.set(parent ?? "root", clientId);
    stack.push({ indent, clientId });
  });
  return entries;
}

// Where `add` puts a new item: --after's parent, --parent, or the page's main
// section (planner pages have none, so they need --parent).
function resolveAddParent(page: PageDoc, nodes: TreeNode[], parentFlag: string | undefined, afterFlag: string | undefined) {
  let parent = parentFlag ?? null;
  if (afterFlag && afterFlag !== "top") {
    const after = nodes.find((n) => n._id === afterFlag) ?? fail("--after must be an active item on this page.");
    if (parentFlag && after.parentNodeId !== parentFlag) fail("--after must be a child of --parent.");
    parent = after.parentNodeId;
  } else if (!parentFlag) {
    const slot = primarySectionSlot(page);
    if (slot === "requireParent") fail("Planner pages need --parent (a day or section id from `tree`).");
    if (slot !== "root") {
      const section = findSectionNode(nodes, slot);
      if (section) parent = section._id;
      else console.error(`This page has no "${slot}" section yet (the app adds it when the page is opened); adding at the page root.`);
    }
  }
  const error = validateParent({ nodeId: null, parentId: parent, targetNodes: nodes });
  if (error) fail(`--parent: ${error}`);
  return parent;
}

async function printStrays(pageId: string, nodes: TreeNode[], walk: (parent: string | null, depth: number) => void) {
  const strays = findStrayNodes(nodes);
  if (!strays.length) return;
  const parents = await resolveNodes([...new Set(strays.map((n) => n.parentNodeId!))]);
  const label = { missing: "parent missing", archived: "parent archived", otherPage: "parent on another page", notLoaded: "" };
  const shown = strays
    .map((node) => ({ node, why: classifyStrayParent(pageId, parents.get(node.parentNodeId!) ?? null) }))
    .filter((entry) => entry.why !== "notLoaded");
  if (!shown.length) return;
  console.log(`\n## Stray items (${shown.length}): active, but the app can't place them under their parent`);
  for (const { node, why } of shown.sort((a, b) => a.node.position - b.node.position)) {
    const box = node.kind === "task" ? (node.taskStatus === "done" ? "[x] " : "[ ] ") : "";
    console.log(`- ${box}${node.text}  (${node._id}; ${label[why]} ${node.parentNodeId})`);
    walk(node._id, 1);
  }
}

// ---- doctor (read-only) ----
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>) {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]);
      }
    }),
  );
  return results;
}

async function doctor() {
  const limitValue = str("limit") ?? "5";
  if (!/^\d+$/.test(limitValue)) fail("--limit must be a whole number.");
  const limit = Number(limitValue);
  const pages = (await query("workspace:listPages")) as PageDoc[];
  const report = {
    pagesChecked: pages.length,
    strayItems: [] as DoctorFinding[],
    untypedPages: pages
      .filter(isUntypedSectionPage)
      .map((page) => ({ pageId: page._id, pageTitle: page.title, text: page.title, detail: `section ${metaOf(page).sidebarSection}, pageType ${metaOf(page).pageType ?? "unset"}` })),
    notesWithTaskStatus: [] as DoctorFinding[],
    recurringWithoutDue: [] as DoctorFinding[],
    endNotAfterDue: [] as DoctorFinding[],
    partiallyLoadedPages: [] as DoctorFinding[],
  };
  const strays: { page: PageDoc; node: TreeNode }[] = [];
  let done = 0;
  await mapLimit(pages, 6, async (page) => {
    const tree = (await query("workspace:getPageTree", { pageId: page._id })) as PageTree | null;
    if (++done % 25 === 0) console.error(`checked ${done}/${pages.length} pages...`);
    if (!tree) return;
    // Only node-loading warnings matter here; partial backlink counts don't.
    if (tree.loadWarning && /too large to load|could not be loaded/.test(tree.loadWarning)) report.partiallyLoadedPages.push({ pageId: page._id, pageTitle: page.title, text: page.title, detail: tree.loadWarning });
    const checks = nodeChecks(page, tree.nodes);
    report.notesWithTaskStatus.push(...checks.notesWithTaskStatus);
    report.recurringWithoutDue.push(...checks.recurringWithoutDue);
    report.endNotAfterDue.push(...checks.endNotAfterDue);
    for (const node of findStrayNodes(tree.nodes)) strays.push({ page, node });
  });

  const parentIds = [...new Set(strays.map((s) => s.node.parentNodeId!))];
  const parents = new Map<string, NodeInfo>();
  for (let i = 0; i < parentIds.length; i += 25) {
    for (const [id, info] of await resolveNodes(parentIds.slice(i, i + 25))) parents.set(id, info);
  }
  const titles = new Map(pages.map((p) => [p._id, p.title]));
  for (const { page, node } of strays) {
    const parent = parents.get(node.parentNodeId!) ?? null;
    const why = classifyStrayParent(page._id, parent);
    if (why === "notLoaded") continue;
    const where = why === "otherPage" ? ` (on "${titles.get(parent!.pageId!) ?? parent!.pageId}")` : "";
    report.strayItems.push({ pageId: page._id, pageTitle: page.title, nodeId: node._id, text: node.text, detail: `parent ${node.parentNodeId} ${why}${where}` });
  }

  if (flags.json) return print(report);
  const sections: [string, DoctorFinding[]][] = [
    ["Stray items (active, parent archived, missing or on another page)", report.strayItems],
    ["Pages under Models/Journal/Views/Scratchpads still typed default", report.untypedPages],
    ["Notes with a task status", report.notesWithTaskStatus],
    ["Recurring items with no due date", report.recurringWithoutDue],
    ["End date not after the due date", report.endNotAfterDue],
    ["Pages too large to check fully (results above may be incomplete)", report.partiallyLoadedPages],
  ];
  console.log(`Checked ${report.pagesChecked} active pages on ${prod ? "production" : "dev"}. Read-only: nothing was changed.\n`);
  for (const [title, findings] of sections) {
    console.log(`${title}: ${findings.length}`);
    for (const f of findings.slice(0, limit)) {
      console.log(`  - "${f.pageTitle}" (${f.pageId})${f.nodeId ? ` ${f.nodeId}: ${JSON.stringify(f.text.slice(0, 60))}` : ""}${f.detail ? ` [${f.detail}]` : ""}`);
    }
    if (findings.length > limit) console.log(`  ... and ${findings.length - limit} more (--limit or --json for all)`);
  }
}

async function main() {
  switch (command) {
    case "pages": {
      const pages = (await query("workspace:listPages")) as { _id: string; title: string }[];
      if (flags.json) return print(pages);
      if (!pages.length) console.error(prod ? "No pages." : "No pages on dev (the dev deployment is often empty; real data is on --prod).");
      for (const page of pages) console.log(`${page._id}  ${page.title}`);
      return;
    }
    case "tree": {
      const result = await loadTree(rest[0]);
      if (flags.json) return print(result);
      if (result.loadWarning) console.error(result.loadWarning);
      console.log(`# ${result.page.title}`);
      const byParent = new Map<string | null, TreeNode[]>();
      for (const node of result.nodes.filter((n) => !n.archived)) {
        const list = byParent.get(node.parentNodeId) ?? [];
        list.push(node);
        byParent.set(node.parentNodeId, list);
      }
      const walk = (parent: string | null, depth: number) => {
        for (const node of (byParent.get(parent) ?? []).sort((a, b) => a.position - b.position)) {
          const box = node.kind === "task" ? (node.taskStatus === "done" ? "[x] " : "[ ] ") : "";
          console.log(`${"  ".repeat(depth)}- ${box}${node.text}  (${node._id})`);
          walk(node._id, depth + 1);
        }
      };
      walk(null, 0);
      return printStrays(rest[0], result.nodes, walk);
    }
    case "add-page": {
      const section = (oneOf("section", SIDEBAR_SECTIONS) ?? "Tasks") as SidebarSection;
      const type = oneOf("type", ["planner"] as const);
      if (type === "planner" && section !== "Tasks") fail("Planner pages live in the Tasks section; drop --section.");
      return ok(await mutation("workspace:createPage", createPageArgs(rest.join(" "), section, type)));
    }
    case "rename-page":
      await mutation("workspace:renamePage", { pageId: rest[0], title: rest.slice(1).join(" ") });
      return ok();
    case "add": {
      const [pageId, ...text] = rest;
      const dueAt = parseDue(str("due"));
      if (str("time") && dueAt == null) fail("--time needs --due.");
      const { page, nodes } = await loadTree(pageId);
      if (page.archived) fail("That page is archived.");
      const parent = resolveAddParent(page, nodes, str("parent"), str("after"));
      const afterNodeId = str("after") === "top" ? null : (str("after") ?? lastChildId(nodes, parent));
      const isTask = Boolean(flags.task) || dueAt != null;
      const nodeId = await mutation("workspace:createNode", {
        pageId,
        text: text.join(" "),
        ...(parent ? { parentNodeId: parent } : {}),
        afterNodeId,
        ...(isTask ? { kind: "task", taskStatus: "todo" } : {}),
        ...(dueAt != null ? { dueAt } : {}),
      });
      // createNode has no time arguments, so set the time in a second write.
      if (str("time")) await mutation("workspace:updateNode", { nodeId, dueAt, ...parseTime(str("time")) });
      return ok(nodeId);
    }
    case "add-outline": {
      const [pageId, file] = rest;
      const nodes = parseOutline(readFileSync(file === "-" ? 0 : file, "utf8"));
      if (!nodes.length) fail("No outline items found (lines must start with - or *).");
      const tree = await loadTree(pageId);
      if (tree.page.archived) fail("That page is archived.");
      const parent = resolveAddParent(tree.page, tree.nodes, undefined, undefined);
      const after = lastChildId(tree.nodes, parent);
      for (const entry of nodes) if (!entry.parentClientId && parent) entry.parentNodeId = parent;
      if (after) nodes[0].afterNodeId = after;
      return ok(await mutation("workspace:createNodesBatch", { pageId, nodes }));
    }
    case "update": {
      const nodeId = rest[0];
      const status = oneOf("status", ["todo", "done"] as const);
      const editFlags = ["text", "due", "time", "priority", "recur", "task", "note"].filter((name) => flags[name] !== undefined);
      if (str("mode") && status !== "done") fail("--mode only applies with --status done.");
      if (status === "done") {
        // Same path as `done`, so completion routing runs and a done item stays done.
        if (editFlags.length) fail("--status done can't be combined with other changes. Run update first, then done.");
        return completeLikeApp(nodeId);
      }
      if (flags.task && flags.note) fail("Use --task or --note, not both.");
      if (!status && !editFlags.length) fail(`Nothing to update.\nUsage: ${spec.usage}`);
      const priority = oneOf("priority", ["low", "medium", "high", "none"] as const);
      const dueAt = parseDue(str("due"));
      const time = parseTime(str("time"));
      const recur = parseRecur(str("recur"));

      const { node } = await loadActiveNode(nodeId);
      const nextKind = flags.task ? "task" : flags.note ? "note" : node.kind;
      if (status && nextKind !== "task") fail("--status is for tasks. Add --task to make it a task, or use done for planner items.");
      if ((flags.task || flags.note) && isNodeLocked(node)) fail("Section headers and planner days can't change kind.");

      const args: Record<string, unknown> = { nodeId };
      if (flags.task || flags.note) Object.assign(args, kindChangeArgs(node, nextKind as "task" | "note"));
      if (str("text") !== undefined) args.text = str("text");
      if (status) args.taskStatus = status;
      if (priority) args.priority = priority === "none" ? null : priority;
      if (dueAt !== undefined) Object.assign(args, scheduleForDue(dueAt, { dueEndAt: args.dueEndAt === null ? null : node.dueEndAt }));
      Object.assign(args, time);
      if (recur !== undefined) args.recurrenceFrequency = recur;
      await mutation("workspace:updateNode", args);
      return ok();
    }
    case "done":
      return completeLikeApp(rest[0]);
    case "move": {
      const nodeId = rest[0];
      const parentFlag = str("parent");
      const afterFlag = str("after");
      if (!str("page") && parentFlag === undefined && afterFlag === undefined) fail(`Say where to move it.\nUsage: ${spec.usage}`);
      const { node, nodes } = await loadActiveNode(nodeId);
      if (isNodeLocked(node)) fail("Section headers and planner days can't be moved.");
      const targetPageId = str("page") ?? node.pageId;
      const crossPage = targetPageId !== node.pageId;
      if (!crossPage && parentFlag === undefined && afterFlag === undefined) fail("It's already on that page; pass --parent or --after.");
      const descendants = collectDescendantIds(nodes, nodeId);
      const target = crossPage ? await loadTree(targetPageId) : null;
      if (target?.page.archived) fail("The destination page is archived.");
      const targetNodes = target?.nodes ?? nodes;

      let parent: string | null | undefined = parentFlag === undefined ? undefined : parentFlag === "root" ? null : parentFlag;
      let afterNodeId: string | null | undefined;
      if (afterFlag === "top") {
        afterNodeId = null;
      } else if (afterFlag) {
        if (afterFlag === nodeId || descendants.has(afterFlag)) fail("--after can't be the item itself or something inside it.");
        const after = targetNodes.find((n) => n._id === afterFlag) ?? fail("--after must be an active item on the destination page.");
        if (parent !== undefined && after.parentNodeId !== parent) fail("--after must be a child of --parent.");
        parent = after.parentNodeId;
        afterNodeId = afterFlag;
      }
      const error = validateParent({ nodeId, parentId: parent ?? null, targetNodes, descendantIds: descendants });
      if (error) fail(`--parent: ${error}`);

      if (crossPage) {
        // Re-pages the whole branch and appends it at the destination's root, like the app's "Move to page".
        await mutation("workspace:moveNodeTreesToPage", { targetPageId, nodeIds: [nodeId] });
        if (!parent && afterNodeId === undefined) return ok();
        // Then place it within the destination page (the branch is already there).
        await mutation("workspace:moveNode", {
          nodeId,
          parentNodeId: parent ?? null,
          afterNodeId: afterNodeId !== undefined ? afterNodeId : lastChildId(targetNodes, parent ?? null, nodeId),
        });
        return ok();
      }
      const nextParent = parent === undefined ? node.parentNodeId : parent;
      await mutation("workspace:moveNode", {
        nodeId,
        parentNodeId: nextParent,
        afterNodeId: afterNodeId !== undefined ? afterNodeId : lastChildId(nodes, nextParent, nodeId),
      });
      return ok();
    }
    case "archive": {
      const info = (await resolveNodes([rest[0]])).get(rest[0]) ?? fail("Node not found.");
      if (info.archived) return console.log("Already archived; nothing changed.");
      const { node } = await loadActiveNode(rest[0]);
      if (isNodeLocked(node)) fail("Section headers and planner days can't be archived (the app would recreate them).");
      await mutation("workspace:setNodeTreeArchived", { nodeId: rest[0], archived: true });
      return ok();
    }
    case "unarchive": {
      const info = (await resolveNodes([rest[0]])).get(rest[0]) ?? fail("Node not found.");
      if (!info.archived) return console.log("Not archived; nothing changed.");
      if (info.pageArchived) fail("That item is on an archived page. Restore the page instead.");
      if (info.parentArchived) fail("Its parent is archived too. Unarchive the parent instead; that restores the whole branch.");
      await mutation("workspace:setNodeTreeArchived", { nodeId: rest[0], archived: false });
      return ok();
    }
    case "doctor":
      return doctor();
    case "run": {
      const [kind, path, json] = rest;
      if (kind !== "query" && kind !== "mutation") fail('run takes "query" or "mutation" (actions are not supported).');
      let args: object = {};
      if (json) {
        try {
          args = JSON.parse(json);
        } catch {
          fail("The json argument is not valid JSON.");
        }
      }
      return print(kind === "mutation" ? await mutation(path, args) : await query(path, args));
    }
  }
}

main().catch((error) => {
  let message = error instanceof Error ? error.message : String(error);
  // Convex validation errors echo the call's arguments, including the key.
  if (connection?.key) message = message.split(connection.key).join("<ownerKey>");
  if (/Invalid owner access token/.test(message)) {
    fail(`${message}\nThe key doesn't match ${prod ? "production" : "dev"}. Check MALESHFLOW_OWNER_KEY or the deployment's OWNER_ACCESS_TOKEN.`);
  }
  fail(message);
});
