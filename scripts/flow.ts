// MaleshFlow CLI: read and change workspace data through the same Convex
// functions the app uses (so links, embeddings and AI hooks still run).
// Usage and examples: docs/flow-cli.md, or `npm run -s flow -- help`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import { anyApi } from "convex/server";
import {
  EXCLUDED_ITEM_MESSAGE,
  EXCLUDED_PAGE_MESSAGE,
  SIDEBAR_SECTIONS,
  classifyStrayParent,
  collectDescendantIds,
  createPageArgs,
  dueEndProblem,
  excludedReferenceProblem,
  findSectionNode,
  findStrayNodes,
  isDataDumpExcluded,
  isNodeCompleted,
  isNodeLocked,
  isUntypedSectionPage,
  kindChangeArgs,
  lastChildId,
  metaOf,
  nodeChecks,
  outlineBatchEntries,
  parseDueDate,
  primarySectionSlot,
  scheduleForDue,
  timeZoneForTime,
  validateParent,
  type DoctorFinding,
  type PageDoc,
  type SidebarSection,
  type TreeNode,
} from "../lib/flow/logic";
import { toStoredLinkText, type LinkLookup } from "../lib/flow/links";
import {
  displayText,
  outlineLine,
  outlineLines,
  parseRecurrence,
  parseTimeOfDay,
  resolveLinkLookup,
  visiblePageTree,
  withLinks,
  type PageTree,
  type VisibleTree,
} from "../lib/flow/format";

type Spec = { args: string[]; optional?: string[]; flags?: string[]; usage: string };

const GLOBAL_FLAGS = ["prod", "yes", "dry-run", "json", "raw"];
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
    flags: ["parent", "after", "task", "due", "due-end", "time"],
    usage:
      "add <pageId> <text> [--parent id] [--after id|top] [--task]\n" +
      "                    [--due YYYY-MM-DD [--due-end YYYY-MM-DD] [--time HH:MM]]\n" +
      "                                         Add a node (end of the page's main section by default)",
  },
  "add-outline": {
    args: ["pageId", "file"],
    usage: "add-outline <pageId> <file|->          Append an outline in one batch (parsed like the app importer)",
  },
  update: {
    args: ["nodeId"],
    flags: ["text", "status", "due", "due-end", "time", "priority", "recur", "recur-basis", "task", "note", "mode"],
    usage:
      "update <nodeId> [--text t] [--status todo|done] [--due YYYY-MM-DD|none] [--due-end YYYY-MM-DD|none]\n" +
      "                [--time HH:MM|none] [--priority low|medium|high|none]\n" +
      "                [--recur daily|weekly|monthly|yearly|<n>d|<n>w|<n>m|<n>y|none] [--task|--note]\n" +
      "                [--recur-basis dueDate|today|none]  (this task's completion basis; none = workspace setting)",
  },
  done: {
    args: ["nodeId"],
    flags: ["mode"],
    usage:
      "done <nodeId> [--mode dueDate|today]   Complete an item the way the app's checkbox does\n" +
      "                                         (planner -> Past Weeks, task pages -> Done, recurring rolls forward);\n" +
      "                                         prints a receipt id for undo-done",
  },
  "undo-done": {
    args: ["receiptId"],
    usage: "undo-done <receiptId>                  Undo a done, checked: refused if the items changed since",
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
       --json (raw output for pages/tree/doctor), --raw (print stored link syntax instead of
       readable links). Docs: docs/flow-cli.md`;

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

// `existingZone`: the item's time zone, kept when it has one.
function parseTime(value: string | undefined, existingZone?: string | null) {
  if (value === undefined) return {};
  let dueTime: string | null;
  try {
    dueTime = parseTimeOfDay(value);
  } catch (error) {
    return fail((error as Error).message);
  }
  if (dueTime === null) return { dueTime: null, dueTimeZone: null };
  return { dueTime, dueTimeZone: timeZoneForTime(existingZone, Intl.DateTimeFormat().resolvedOptions().timeZone) };
}

function parseRecur(value: string | undefined) {
  try {
    return parseRecurrence(value);
  } catch {
    return fail(`Bad --recur "${value}"; use daily|weekly|monthly|yearly, <n>d|w|m|y, or none.`);
  }
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

// ---- links ----
// Item text prints with links resolved (see lib/flow/links.ts and
// docs/flow-cli.md): one workspace:resolveLinkTargets call per command
// (per 500 targets). --raw skips it and prints stored text.
async function resolveLinkText(texts: string[]): Promise<LinkLookup | null> {
  if (flags.raw) return null;
  try {
    return await resolveLinkLookup(texts, query);
  } catch (error) {
    // E.g. a deployment from before workspace:resolveLinkTargets (production
    // reports that only as "Server Error"). Output still works, unresolved.
    console.error(`Couldn't resolve links (${(error as Error)?.message ?? error}); showing stored link syntax.`);
    return null;
  }
}
const display = displayText;

// ---- reads ----
type NodeInfo = { nodeId: string; pageId: string | null; archived: boolean; pageArchived: boolean; parentNodeId: string | null; parentArchived: boolean };

const visibleTree = (result: PageTree): VisibleTree | null => visiblePageTree(result);

// Every command reads pages through here, so excluded pages and items never
// reach the output or a write.
async function loadTree(pageId: string): Promise<VisibleTree> {
  const result = (await query("workspace:getPageTree", { pageId })) as PageTree | null;
  if (!result) fail("Page not found.");
  return visibleTree(result) ?? fail(EXCLUDED_PAGE_MESSAGE);
}

// Refuses a node that is excluded from data dumps (or on an excluded page).
// Returns its page tree.
async function loadVisibleNodePage(nodeId: string, info: NodeInfo | undefined) {
  if (!info?.pageId) fail("Node not found.");
  const tree = await loadTree(info.pageId);
  if (tree.excludedNodeIds.has(nodeId)) fail(EXCLUDED_ITEM_MESSAGE);
  return tree;
}

// With no --parent the server adds to the page's main section; refuse when
// that section is hidden (it's excluded, so it isn't in the visible tree).
function refuseExcludedDefaultSection(tree: VisibleTree) {
  const slot = primarySectionSlot(tree.page);
  if (slot === "root" || slot === "requireParent" || !tree.excludedNodeIds.size) return;
  if (!findSectionNode(tree.nodes, slot)) fail(`This page's "${slot}" section is missing or excluded from data dumps; pass --parent.`);
}

function refuseExcludedReference(flag: string, id: string | null | undefined, tree: VisibleTree) {
  const problem = excludedReferenceProblem(flag, id, tree.excludedNodeIds);
  if (problem) fail(problem);
}

async function resolveNodes(nodeIds: string[]) {
  const infos = (await query("workspace:resolveNodeLinks", { nodeIds })) as NodeInfo[];
  return new Map(infos.map((info) => [info.nodeId, info]));
}

// An active node with its page and that page's active tree.
async function loadActiveNode(nodeId: string) {
  const info = (await resolveNodes([nodeId])).get(nodeId);
  const tree = await loadVisibleNodePage(nodeId, info);
  if (info!.archived) fail("That item is archived. Unarchive it first.");
  if (info!.pageArchived) fail("That item is on an archived page, which the app doesn't edit.");
  const node = tree.nodes.find((n) => n._id === nodeId) ?? fail("Node not found in its page tree (the page may be too large to load).");
  return { node, page: tree.page, nodes: tree.nodes, tree };
}

// Completes an item through workspace:setNodeCompletion, the same server path
// as the app's checkbox: it routes planner items, task pages with a Done
// archive, recurring tasks and notes. intent "complete" never reopens, and the
// revision we read makes a repeated or stale request change nothing.
type CompletionResult = {
  status: "applied" | "noop" | "stale";
  route: string;
  receiptId?: string | null;
  before: { revision: number };
  after: { taskStatus: string | null; noteCompleted: boolean; dueAt: number | null } | null;
};

const ROUTE_LABELS: Record<string, string> = {
  planner: "planner item (Past Weeks flow)",
  plannerPreview: "planner copy of this task",
  taskPage: "task page with a Done archive",
  recurring: "recurring task, rolled forward to the next due date",
  task: "task marked done",
  note: "note marked completed",
};

async function completeLikeApp(nodeId: string) {
  // A task's own basis wins (server side); then --mode; then today.
  const completionMode = oneOf("mode", ["dueDate", "today"] as const) ?? "today";
  const info = (await resolveNodes([nodeId])).get(nodeId);
  if (info?.archived) await loadVisibleNodePage(nodeId, info);
  if (info?.archived) {
    // Completed planner and task-page items are archived (Past Weeks / Done).
    return console.log("That item is archived (completed planner and task-page items are); nothing changed.");
  }
  const { node } = await loadActiveNode(nodeId);
  if (isNodeCompleted(node)) return console.log("Already done; nothing changed.");
  const result = (await mutation("workspace:setNodeCompletion", {
    nodeId,
    intent: "complete",
    completionMode,
    expectedRevision: node.revision ?? 0,
  })) as CompletionResult | string;
  if (dryRun || typeof result !== "object") return ok();
  if (result.status === "stale") fail("The item changed since it was read; nothing changed. Run done again.");
  if (result.status === "noop") return console.log("Already done; nothing changed.");
  console.error(`Completed: ${ROUTE_LABELS[result.route] ?? result.route} (mode ${completionMode}).`);
  if (!result.receiptId) return ok();
  console.error(`Receipt (undo with: undo-done ${result.receiptId}):`);
  return ok(result.receiptId);
}

// Where `add` puts a new item: --after's parent, --parent, or the page's main
// section (planner pages have none, so they need --parent).
function resolveAddParent(tree: VisibleTree, parentFlag: string | undefined, afterFlag: string | undefined) {
  const { page, nodes } = tree;
  refuseExcludedReference("parent", parentFlag, tree);
  refuseExcludedReference("after", afterFlag, tree);
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

async function printStrays(pageId: string, nodes: TreeNode[], walk: (parent: string | null, depth: number) => void, lookup: LinkLookup | null) {
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
    console.log(outlineLine(node, 0, lookup, `${node._id}; ${label[why]} ${node.parentNodeId}`));
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
  // Pages and items excluded from data dumps are skipped, the same as the export.
  const allPages = (await query("workspace:listPages")) as PageDoc[];
  const pages = allPages.filter((page) => !isDataDumpExcluded(page));
  const excludedPageIds = new Set(allPages.filter((page) => isDataDumpExcluded(page)).map((page) => page._id));
  const excludedNodeIds = new Set<string>();
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
    const rawTree = (await query("workspace:getPageTree", { pageId: page._id })) as PageTree | null;
    if (++done % 25 === 0) console.error(`checked ${done}/${pages.length} pages...`);
    const tree = rawTree ? visibleTree(rawTree) : null;
    if (!tree) return;
    for (const id of tree.excludedNodeIds) excludedNodeIds.add(id);
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
    // Don't name an excluded page.
    const parentHidden = why === "otherPage" && excludedPageIds.has(parent!.pageId!);
    const where = why === "otherPage" ? (parentHidden ? " (on a page excluded from data dumps)" : ` (on "${titles.get(parent!.pageId!) ?? parent!.pageId}")`) : "";
    report.strayItems.push({ pageId: page._id, pageTitle: page.title, nodeId: node._id, text: node.text, detail: `parent ${node.parentNodeId} ${why}${where}` });
  }

  // Writes the server guards flagged (record mode logs instead of refusing).
  type GuardViolations = { mode: string; total: number; truncated: boolean; counts: Record<string, number>; recent: { mutation: string; guard: string; nodeId: string | null; pageId: string | null; detail: string; createdAt: number }[] };
  let guards: GuardViolations | null = null;
  try {
    guards = (await query("guardViolations:list", { limit })) as GuardViolations;
  } catch {
    // Deployments without Phase 2 don't have this query yet.
  }

  // Rows about excluded pages or items are dropped; the counts stay (they hold no content).
  if (guards) {
    guards = {
      ...guards,
      recent: guards.recent.filter((row) => !(row.pageId && excludedPageIds.has(row.pageId)) && !(row.nodeId && excludedNodeIds.has(row.nodeId))),
    };
  }
  const findingLists = [report.strayItems, report.notesWithTaskStatus, report.recurringWithoutDue, report.endNotAfterDue];
  if (flags.json) {
    const lookup = await resolveLinkText(findingLists.flat().map((f) => f.text));
    const linked = (findings: DoctorFinding[]) => findings.map((f) => withLinks(f, lookup));
    return print({
      ...report,
      strayItems: linked(report.strayItems),
      notesWithTaskStatus: linked(report.notesWithTaskStatus),
      recurringWithoutDue: linked(report.recurringWithoutDue),
      endNotAfterDue: linked(report.endNotAfterDue),
      excludedPagesSkipped: excludedPageIds.size,
      guardViolations: guards,
    });
  }
  const lookup = await resolveLinkText(findingLists.flatMap((findings) => findings.slice(0, limit)).filter((f) => f.nodeId).map((f) => f.text));
  const sections: [string, DoctorFinding[]][] = [
    ["Stray items (active, parent archived, missing or on another page)", report.strayItems],
    ["Pages under Models/Journal/Views/Scratchpads still typed default", report.untypedPages],
    ["Notes with a task status", report.notesWithTaskStatus],
    ["Recurring items with no due date", report.recurringWithoutDue],
    ["End date not after the due date", report.endNotAfterDue],
    ["Pages too large to check fully (results above may be incomplete)", report.partiallyLoadedPages],
  ];
  const skipped = excludedPageIds.size ? ` (skipped ${excludedPageIds.size} excluded from data dumps)` : "";
  console.log(`Checked ${report.pagesChecked} active pages on ${prod ? "production" : "dev"}${skipped}. Read-only: nothing was changed.\n`);
  for (const [title, findings] of sections) {
    console.log(`${title}: ${findings.length}`);
    for (const f of findings.slice(0, limit)) {
      console.log(`  - "${f.pageTitle}" (${f.pageId})${f.nodeId ? ` ${f.nodeId}: ${JSON.stringify(display(f.text, lookup).slice(0, 80))}` : ""}${f.detail ? ` [${f.detail}]` : ""}`);
    }
    if (findings.length > limit) console.log(`  ... and ${findings.length - limit} more (--limit or --json for all)`);
  }
  if (!guards) return console.log("Guard violations: not available (this deployment has no guardViolations:list yet)");
  console.log(`Guard violations (server guards in ${guards.mode} mode): ${guards.total}${guards.truncated ? "+" : ""}`);
  for (const [key, count] of Object.entries(guards.counts).sort((a, b) => b[1] - a[1])) console.log(`  ${count}  ${key}`);
  for (const row of guards.recent.slice(0, limit)) {
    console.log(`  - ${new Date(row.createdAt).toISOString()} ${row.mutation} ${row.guard}${row.nodeId ? ` node ${row.nodeId}` : ""}${row.pageId ? ` page ${row.pageId}` : ""}: ${row.detail}`);
  }
}

async function main() {
  switch (command) {
    case "pages": {
      const pages = ((await query("workspace:listPages")) as PageDoc[]).filter((page) => !isDataDumpExcluded(page));
      if (flags.json) return print(pages);
      if (!pages.length) console.error(prod ? "No pages." : "No pages on dev (the dev deployment is often empty; real data is on --prod).");
      for (const page of pages) console.log(`${page._id}  ${page.title}`);
      return;
    }
    case "tree": {
      const { excludedNodeIds, ...result } = await loadTree(rest[0]);
      if (excludedNodeIds.size) console.error(`${excludedNodeIds.size} item${excludedNodeIds.size === 1 ? "" : "s"} excluded from data dumps not shown.`);
      const lookup = await resolveLinkText(result.nodes.map((node) => node.text));
      if (flags.json) return print({ ...result, nodes: result.nodes.map((node) => withLinks(node, lookup)) });
      if (result.loadWarning) console.error(result.loadWarning);
      console.log(`# ${result.page.title}`);
      const walk = (parent: string | null, depth: number) => {
        for (const line of outlineLines(result.nodes, lookup, parent, depth)) console.log(line);
      };
      walk(null, 0);
      return printStrays(rest[0], result.nodes, walk, lookup);
    }
    case "add-page": {
      const section = (oneOf("section", SIDEBAR_SECTIONS) ?? "Tasks") as SidebarSection;
      const type = oneOf("type", ["planner"] as const);
      if (type === "planner" && section !== "Tasks") fail("Planner pages live in the Tasks section; drop --section.");
      return ok(await mutation("workspace:createPage", createPageArgs(rest.join(" "), section, type)));
    }
    case "rename-page":
      await loadTree(rest[0]);
      await mutation("workspace:renamePage", { pageId: rest[0], title: rest.slice(1).join(" ") });
      return ok();
    case "add": {
      const [pageId, ...text] = rest;
      const dueAt = parseDue(str("due"));
      if (str("time") && dueAt == null) fail("--time needs --due.");
      const dueEndAt = parseDue(str("due-end"));
      if (dueEndAt !== undefined) {
        const problem = dueEndProblem(dueEndAt, dueAt);
        if (problem) fail(problem);
      }
      const tree = await loadTree(pageId);
      const { page, nodes } = tree;
      if (page.archived) fail("That page is archived.");
      // With no --parent/--after the server puts it at the end of the page's
      // primary section (createNode's default parent).
      const placed = str("parent") !== undefined || str("after") !== undefined;
      if (!placed && primarySectionSlot(page) === "requireParent") fail("Planner pages need --parent (a day or section id from `tree`).");
      if (!placed) refuseExcludedDefaultSection(tree);
      const parent = placed ? resolveAddParent(tree, str("parent"), str("after")) : undefined;
      const afterFlag = str("after");
      // --parent alone appends after the parent's last child (a batch entry
      // with a parent and no position would go first).
      let afterNodeId: string | null | undefined;
      if (afterFlag === "top") afterNodeId = null;
      else if (afterFlag) afterNodeId = afterFlag;
      else if (parent) afterNodeId = lastChildId(nodes, parent) ?? null;
      const isTask = Boolean(flags.task) || dueAt != null;
      // One createNodesBatch entry, so text, kind, schedule, time zone and the
      // kind lock land in one write (createNode has no time or lock fields).
      const entry = {
        text: toStoredLinkText(text.join(" ")),
        ...(parent !== undefined ? { parentNodeId: parent } : {}),
        ...(afterNodeId !== undefined ? { afterNodeId } : {}),
        // An explicit --task locks the kind, like the app's toggle, so AI
        // tagging won't flip it back to a note.
        ...(isTask ? { kind: "task", taskStatus: "todo", lockKind: true } : {}),
        ...(dueAt != null ? { dueAt, ...parseTime(str("time")) } : {}),
        ...(dueEndAt != null ? { dueEndAt } : {}),
      };
      const created = await mutation("workspace:createNodesBatch", { pageId, nodes: [entry], parseDraft: true });
      return ok(Array.isArray(created) ? (created[0] as { _id: string })._id : created);
    }
    case "add-outline": {
      const [pageId, file] = rest;
      // The app importer's parser: tasks, due markers, recurrence, kind lock.
      const nodes = outlineBatchEntries(toStoredLinkText(readFileSync(file === "-" ? 0 : file, "utf8")));
      if (!nodes.length) fail("No outline items found.");
      const tree = await loadTree(pageId);
      if (tree.page.archived) fail("That page is archived.");
      if (primarySectionSlot(tree.page) === "requireParent") fail("Planner pages need --parent (a day or section id from `tree`).");
      refuseExcludedDefaultSection(tree);
      // Top-level outline items name no parent, so the server adds them at the
      // end of the page's primary section. Like the app's importer, the
      // entries are already parsed, so no parseDraft.
      const created = await mutation("workspace:createNodesBatch", { pageId, nodes });
      if (dryRun || !Array.isArray(created)) return ok();
      console.error(`Added ${created.length} item${created.length === 1 ? "" : "s"}.`);
      return ok((created as { _id: string }[]).map((node) => node._id).join("\n"));
    }
    case "update": {
      const nodeId = rest[0];
      const status = oneOf("status", ["todo", "done"] as const);
      const editFlags = ["text", "due", "due-end", "time", "priority", "recur", "recur-basis", "task", "note"].filter((name) => flags[name] !== undefined);
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
      const dueEndAt = parseDue(str("due-end"));
      const recur = parseRecur(str("recur"));
      const recurBasis = oneOf("recur-basis", ["dueDate", "today", "none"] as const);

      const { node } = await loadActiveNode(nodeId);
      const nextKind = flags.task ? "task" : flags.note ? "note" : node.kind;
      if (status && nextKind !== "task") fail("--status is for tasks. Add --task to make it a task, or use done for planner items.");
      if ((flags.task || flags.note) && isNodeLocked(node)) fail("Section headers and planner days can't change kind.");
      // Times and recurrence belong to tasks; "none" may still clear them.
      const setsTime = str("time") !== undefined && str("time") !== "none";
      const setsRecur = recur !== undefined && recur !== null;
      if (nextKind !== "task" && (setsTime || setsRecur)) {
        fail(`${setsTime ? "--time" : "--recur"} is for tasks; this is a note. Add --task to make it a task.`);
      }
      // A kind change to a task resets the schedule, so the item's old due
      // date only counts when the kind stays.
      const keptDueAt = flags.task && node.kind !== "task" ? null : (node.dueAt ?? null);
      const effectiveDueAt = dueAt !== undefined ? dueAt : keptDueAt;
      if (setsTime && effectiveDueAt === null) fail("--time needs a due date (pass --due, or set one first).");
      if (dueEndAt !== undefined) {
        const problem = dueEndProblem(dueEndAt, effectiveDueAt);
        if (problem) fail(problem);
      }
      // --time keeps the item's time zone when it has one.
      const time = parseTime(str("time"), node.dueTimeZone);

      const args: Record<string, unknown> = { nodeId };
      if (flags.task || flags.note) Object.assign(args, kindChangeArgs(node, nextKind as "task" | "note"));
      // Readable links copied from output go back to the stored syntax; links
      // that match the item's current ones keep their exact stored form.
      if (str("text") !== undefined) Object.assign(args, { text: toStoredLinkText(str("text")!, node.text), parseDraft: true });
      if (status) args.taskStatus = status;
      if (priority) args.priority = priority === "none" ? null : priority;
      if (dueAt !== undefined) Object.assign(args, scheduleForDue(dueAt, { dueEndAt: args.dueEndAt === null ? null : node.dueEndAt }));
      if (dueEndAt !== undefined) args.dueEndAt = dueEndAt;
      Object.assign(args, time);
      if (recur !== undefined) args.recurrenceFrequency = recur;
      if (recurBasis && nextKind !== "task") fail("--recur-basis is for tasks.");
      if (Object.keys(args).length > 1) await mutation("workspace:updateNode", args);
      if (recurBasis) {
        await mutation("workspace:setRecurrenceBasis", { nodeId, basis: recurBasis === "none" ? null : recurBasis });
      }
      return ok();
    }
    case "done":
      return completeLikeApp(rest[0]);
    case "undo-done": {
      // workspace:undoCompletion checks the receipt first: if anything it
      // touched changed since (an edit, a new child under a Done or Past
      // Weeks copy), it refuses with what changed, and nothing is undone.
      const results = (await mutation("workspace:undoCompletion", { receiptIds: [rest[0]] })) as unknown;
      if (dryRun || !Array.isArray(results)) return ok();
      console.error("Undone.");
      return ok();
    }
    case "move": {
      const nodeId = rest[0];
      const parentFlag = str("parent");
      const afterFlag = str("after");
      if (!str("page") && parentFlag === undefined && afterFlag === undefined) fail(`Say where to move it.\nUsage: ${spec.usage}`);
      const { node, nodes, tree: sourceTree } = await loadActiveNode(nodeId);
      if (isNodeLocked(node)) fail("Section headers and planner days can't be moved.");
      const targetPageId = str("page") ?? node.pageId;
      const crossPage = targetPageId !== node.pageId;
      if (!crossPage && parentFlag === undefined && afterFlag === undefined) fail("It's already on that page; pass --parent or --after.");
      const descendants = collectDescendantIds(nodes, nodeId);
      const target = crossPage ? await loadTree(targetPageId) : null;
      if (target?.page.archived) fail("The destination page is archived.");
      const targetNodes = target?.nodes ?? nodes;
      const targetTree = target ?? sourceTree;
      if (parentFlag !== "root") refuseExcludedReference("parent", parentFlag, targetTree);
      if (afterFlag !== "top") refuseExcludedReference("after", afterFlag, targetTree);

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

      // One whole-branch move (workspace:moveNodeTree, the same mutation as the
      // app's cut and paste): children, links and favorites come along, and
      // without --after it lands at the end of the destination.
      const result = await mutation("workspace:moveNodeTree", {
        nodeIds: [nodeId],
        pageId: targetPageId,
        parentNodeId: parent === undefined ? (crossPage ? null : node.parentNodeId) : parent,
        ...(afterNodeId !== undefined ? { afterNodeId } : {}),
      });
      return ok(result);
    }
    case "archive": {
      const info = (await resolveNodes([rest[0]])).get(rest[0]) ?? fail("Node not found.");
      await loadVisibleNodePage(rest[0], info);
      if (info.archived) return console.log("Already archived; nothing changed.");
      const { node } = await loadActiveNode(rest[0]);
      if (isNodeLocked(node)) fail("Section headers and planner days can't be archived (the app would recreate them).");
      await mutation("workspace:setNodeTreeArchived", { nodeId: rest[0], archived: true });
      return ok();
    }
    case "unarchive": {
      const info = (await resolveNodes([rest[0]])).get(rest[0]) ?? fail("Node not found.");
      await loadVisibleNodePage(rest[0], info);
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
  // ConvexErrors carry a clean message in `data` (e.g. a refused undo).
  if (error instanceof ConvexError) {
    const data = error.data as unknown;
    if (typeof data === "string") message = data;
    else if (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string") {
      message = (data as { message: string }).message;
    }
  }
  // Convex validation errors echo the call's arguments, including the key.
  if (connection?.key) message = message.split(connection.key).join("<ownerKey>");
  if (/Invalid owner access token/.test(message)) {
    fail(`${message}\nThe key doesn't match ${prod ? "production" : "dev"}. Check MALESHFLOW_OWNER_KEY or the deployment's OWNER_ACCESS_TOKEN.`);
  }
  fail(message);
});
