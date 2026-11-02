// MaleshFlow CLI: read and change workspace data through the same Convex
// functions the app uses (so links, embeddings and AI hooks still run).
// Usage and examples: docs/flow-cli.md, or `npm run -s flow -- help`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { advanceRecurringDueDateRange, parseRecurrenceFrequency } from "../lib/domain/recurrence";

type Spec = { args: string[]; optional?: string[]; flags?: string[]; usage: string };

const GLOBAL_FLAGS = ["prod", "yes", "dry-run", "json"];
const BOOLEAN_FLAGS = new Set([...GLOBAL_FLAGS, "task", "note"]);
const COMMANDS: Record<string, Spec> = {
  pages: { args: [], usage: "pages                                  List pages (id, title)" },
  tree: { args: ["pageId"], usage: "tree <pageId>                          Print a page outline with node ids" },
  "add-page": { args: ["title..."], flags: ["section"], usage: "add-page <title> [--section Notes]     Create a page" },
  "rename-page": { args: ["pageId", "title..."], usage: "rename-page <pageId> <title>           Rename a page" },
  add: {
    args: ["pageId", "text..."],
    flags: ["parent", "after", "task", "due", "time"],
    usage:
      "add <pageId> <text> [--parent id] [--after id|top] [--task] [--due YYYY-MM-DD [--time HH:MM]]\n" +
      "                                         Add a node (appends to the end by default)",
  },
  "add-outline": {
    args: ["pageId", "file"],
    usage: "add-outline <pageId> <file|->          Append a markdown outline in one batch",
  },
  update: {
    args: ["nodeId"],
    flags: ["text", "status", "due", "time", "priority", "recur", "task", "note"],
    usage:
      "update <nodeId> [--text t] [--status todo|in_progress|done|cancelled] [--due YYYY-MM-DD|none]\n" +
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
      "                                         Move a node (and its children); appends by default",
  },
  archive: { args: ["nodeId"], usage: "archive <nodeId>                       Archive (hide) a node" },
  unarchive: { args: ["nodeId"], usage: "unarchive <nodeId>                     Restore an archived node" },
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

Flags: --prod (production; writes also need --yes), --dry-run (print the write, don't send),
       --json (raw output for pages/tree). Docs: docs/flow-cli.md`;

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
const oneOf = (name: string, allowed: string[]) => {
  const value = str(name);
  if (value !== undefined && !allowed.includes(value)) fail(`--${name} must be one of: ${allowed.join(", ")}`);
  return value;
};
const prod = Boolean(flags.prod);

// Due dates are midnight in this machine's time zone, like dates picked in the app.
function parseDue(value: string | undefined) {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(`Bad date "${value}"; use YYYY-MM-DD or none.`);
  const ms = Date.parse(`${value}T00:00:00`);
  return Number.isNaN(ms) ? fail(`Bad date "${value}".`) : ms;
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
// --dry-run prints the write and exits. It is not validated by the backend,
// and it may still read live data first (e.g. to find where to append).
const mutation = (path: string, args: object = {}) => {
  if (flags["dry-run"]) {
    console.log(`[dry-run] ${path} ${JSON.stringify(args, null, 2)}`);
    return process.exit(0);
  }
  if (prod && !flags.yes) fail("Refusing to write to production without --yes (try --dry-run first).");
  const { client, key } = connect();
  return client.mutation(fn(path), { ownerKey: key, ...args });
};
const print = (value: unknown) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

type TreeNode = {
  _id: string;
  pageId: string;
  parentNodeId: string | null;
  position: number;
  text: string;
  kind: string;
  taskStatus: string | null;
  archived: boolean;
  dueAt?: number | null;
  dueEndAt?: number | null;
  sourceMeta?: Record<string, unknown> | null;
};

type PageDoc = { _id: string; title: string; archived?: boolean; sourceMeta?: Record<string, unknown> | null };

const metaOf = (value: { sourceMeta?: unknown } | null | undefined) =>
  value && typeof value.sourceMeta === "object" && value.sourceMeta ? (value.sourceMeta as Record<string, unknown>) : {};

// Mirrors isPlannerLinkedTaskCopy / isPlannerCompletionItem in components/WorkspaceApp.tsx.
const isPlannerLinkedTaskCopy = (node: TreeNode) => {
  const meta = metaOf(node);
  return meta.plannerKind === "plannerLinkedTask" && typeof meta.sourceTaskNodeId === "string" && meta.sourceTaskNodeId.length > 0;
};
function isPlannerCompletionItem(node: TreeNode, nodeMap: Map<string, TreeNode>) {
  if (isPlannerLinkedTaskCopy(node)) return true;
  let parentId = node.parentNodeId;
  while (parentId) {
    const parent = nodeMap.get(parentId);
    if (!parent) return false;
    const meta = metaOf(parent);
    if (meta.plannerKind === "plannerDay" || meta.sectionSlot === "plannerFocus" || isPlannerLinkedTaskCopy(parent)) return true;
    parentId = parent.parentNodeId;
  }
  return false;
}

// Picks the same completion path as the app's task checkbox
// (toggleSelectedNodesCompletion in components/WorkspaceApp.tsx).
async function completeLikeApp(nodeId: string) {
  const completionMode = (oneOf("mode", ["dueDate", "today"]) ?? "dueDate") as "dueDate" | "today";
  const [resolved] = (await query("workspace:resolveNodeLinks", { nodeIds: [nodeId] })) as Array<{ pageId: string | null } | null>;
  const pageId = resolved?.pageId ?? fail("Node not found.");
  const { nodes } = await loadTree(pageId);
  const nodeMap = new Map(nodes.map((n) => [n._id, n]));
  const node = nodeMap.get(nodeId) ?? fail("Node not found.");
  if (node.archived) fail("That item is archived.");
  const pages = (await query("workspace:listPages")) as PageDoc[];
  const page = pages.find((p) => p._id === pageId);
  if (!page || page.archived) fail("That item is on an archived page, which the app doesn't complete.");
  const pageMeta = metaOf(page);
  const isSidebarPage = pageMeta.specialPage === "sidebar";
  const isTaskPage = !isSidebarPage && pageMeta.pageType !== "planner" && (pageMeta.pageType === "task" || pageMeta.sidebarSection === "Tasks");

  if (isPlannerCompletionItem(node, nodeMap)) {
    // Planner day/focus items: completing the last open item archives the day to Past Weeks.
    console.error(`Planner item on "${page.title}": using planner:completePlannerTask.`);
    await mutation("planner:completePlannerTask", { plannerNodeId: nodeId, completionMode });
    return console.log("ok");
  }
  if (node.kind !== "task") fail("Only tasks (or planner items) can be completed. Use update --task first.");
  if (node.taskStatus === "done") return console.log("Already done.");
  if (isTaskPage && pageMeta.archiveCompletedRootTasksToDone === true) {
    console.error(`Task page "${page.title}": using workspace:completeTaskPageTask.`);
    await mutation("workspace:completeTaskPageTask", { nodeId, completionMode });
    return console.log("ok");
  }
  const frequency = parseRecurrenceFrequency(metaOf(node).recurrenceFrequency);
  if (frequency !== null && node.dueAt) {
    const next = advanceRecurringDueDateRange({ dueAt: node.dueAt, dueEndAt: node.dueEndAt ?? null, frequency, mode: completionMode });
    console.error(`Recurring task: rolling forward to the next due date (mode ${completionMode}).`);
    await mutation("workspace:updateNode", { nodeId, kind: "task", lockKind: true, taskStatus: "todo", dueAt: next.dueAt, dueEndAt: next.dueEndAt });
    return console.log("ok");
  }
  await mutation("workspace:updateNode", { nodeId, kind: "task", lockKind: true, taskStatus: "done" });
  return console.log("ok");
}

async function loadTree(pageId: string) {
  const result = (await query("workspace:getPageTree", { pageId })) as { page: { title: string }; nodes: TreeNode[] } | null;
  return result ?? fail("Page not found.");
}

// Last visible child under `parent`, so new items append instead of landing on top.
async function lastChildId(pageId: string, parent: string | null, exclude?: string) {
  const { nodes } = await loadTree(pageId);
  const siblings = nodes.filter((n) => !n.archived && n.parentNodeId === parent && n._id !== exclude);
  siblings.sort((a, b) => a.position - b.position);
  return siblings.at(-1)?._id ?? null;
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
      return;
    }
    case "add-page":
      return print(await mutation("workspace:createPage", { title: rest.join(" "), ...(str("section") ? { sidebarSection: str("section") } : {}) }));
    case "rename-page":
      await mutation("workspace:renamePage", { pageId: rest[0], title: rest.slice(1).join(" ") });
      return console.log("ok");
    case "add": {
      const [pageId, ...text] = rest;
      const parent = str("parent") ?? null;
      const dueAt = parseDue(str("due"));
      if (str("time") && dueAt == null) fail("--time needs --due.");
      const afterNodeId = str("after") === "top" ? null : (str("after") ?? (await lastChildId(pageId, parent)));
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
      return print(nodeId);
    }
    case "add-outline": {
      const [pageId, file] = rest;
      const nodes = parseOutline(readFileSync(file === "-" ? 0 : file, "utf8"));
      if (!nodes.length) fail("No outline items found (lines must start with - or *).");
      const after = await lastChildId(pageId, null);
      if (after) nodes[0].afterNodeId = after;
      return print(await mutation("workspace:createNodesBatch", { pageId, nodes }));
    }
    case "update": {
      const args: Record<string, unknown> = { nodeId: rest[0] };
      if (str("text") !== undefined) args.text = str("text");
      const status = oneOf("status", ["todo", "in_progress", "done", "cancelled"]);
      if (status) args.taskStatus = status;
      const priority = oneOf("priority", ["low", "medium", "high", "none"]);
      if (priority) args.priority = priority === "none" ? null : priority;
      const dueAt = parseDue(str("due"));
      if (dueAt !== undefined) args.dueAt = dueAt;
      Object.assign(args, parseTime(str("time")));
      const recur = parseRecur(str("recur"));
      if (recur !== undefined) args.recurrenceFrequency = recur;
      if (flags.task && flags.note) fail("Use --task or --note, not both.");
      if (flags.task) args.kind = "task";
      if (flags.note) args.kind = "note";
      if (Object.keys(args).length === 1) fail(`Nothing to update.\nUsage: ${spec.usage}`);
      await mutation("workspace:updateNode", args);
      return console.log("ok");
    }
    case "done":
      return completeLikeApp(rest[0]);
    case "move": {
      const parentFlag = str("parent");
      const args: Record<string, unknown> = { nodeId: rest[0] };
      if (str("page")) args.pageId = str("page");
      if (parentFlag) args.parentNodeId = parentFlag === "root" ? null : parentFlag;
      if (!str("page") && !parentFlag && !str("after")) fail(`Say where to move it.\nUsage: ${spec.usage}`);
      if (str("after") === "top") {
        args.afterNodeId = null;
      } else if (str("after")) {
        args.afterNodeId = str("after");
      } else {
        // Append at the end of the destination. Without --parent, a move to
        // another page lands at its root; a move within the page keeps the parent.
        const pageId = (args.pageId as string | undefined) ?? fail("Use --after with --parent alone, or pass --page.");
        const parent = parentFlag && parentFlag !== "root" ? parentFlag : null;
        if (parentFlag === undefined) args.parentNodeId = null;
        args.afterNodeId = await lastChildId(pageId, parent, rest[0]);
      }
      await mutation("workspace:moveNode", args);
      return console.log("ok");
    }
    case "archive":
    case "unarchive":
      await mutation("workspace:archiveNode", { nodeId: rest[0], archived: command === "archive" });
      return console.log("ok");
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
