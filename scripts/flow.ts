// MaleshFlow CLI: read and change workspace data through the same Convex
// functions the app uses (so links, embeddings and AI hooks still run).
//
//   npx tsx scripts/flow.ts <command> [args] [--prod --yes]
//
// Target: dev deployment from .env.local by default. --prod targets
// production (override with MALESHFLOW_PROD_URL) and refuses writes without --yes.
// Owner key: MALESHFLOW_OWNER_KEY, else read via `npx convex env get`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const HELP = `Commands:
  pages                                  List pages (id, title)
  tree <pageId>                          Print a page's outline with node ids
  add-page <title> [--section Notes]     Create a page
  add <pageId> <text> [--parent id] [--after id|top] [--task] [--due YYYY-MM-DD]
                                         (appends to the end unless --after is given)
  add-outline <pageId> <file|->          Append a markdown outline ("- item", "- [ ] task",
                                         2-space indent nests) in one batch
  rename-page <pageId> <title>
  update <nodeId> [--text t] [--status todo|in_progress|done|cancelled]
                  [--due YYYY-MM-DD|none] [--task|--note]
  done <nodeId>                          Mark a task done
  archive <nodeId>                       Archive a node
  run <query|mutation> <module:fn> [json] Call any function (ownerKey added)
Flags: --prod (production; writes also need --yes), --json (raw output),
       --dry-run (print the write instead of sending it)`;

const argv = process.argv.slice(2);
const flags: Record<string, string | boolean> = {};
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg.startsWith("--")) {
    const name = arg.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--") && !["prod", "yes", "json", "task", "note", "dry-run"].includes(name)) {
      flags[name] = next;
      i++;
    } else {
      flags[name] = true;
    }
  } else {
    positional.push(arg);
  }
}
const [command, ...rest] = positional;
const prod = Boolean(flags.prod);

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function deploymentUrl() {
  if (prod) {
    return process.env.MALESHFLOW_PROD_URL ?? "https://precise-coyote-972.convex.cloud";
  }
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  return env.match(/^NEXT_PUBLIC_CONVEX_URL=(\S+)/m)?.[1] ?? fail("NEXT_PUBLIC_CONVEX_URL missing from .env.local");
}

function ownerKey() {
  if (process.env.MALESHFLOW_OWNER_KEY) return process.env.MALESHFLOW_OWNER_KEY;
  const out = execFileSync("npx", ["convex", "env", "get", "OWNER_ACCESS_TOKEN", ...(prod ? ["--prod"] : [])], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return out || fail("Could not read OWNER_ACCESS_TOKEN; set MALESHFLOW_OWNER_KEY.");
}

function parseDue(value: string | boolean | undefined) {
  if (value === undefined) return undefined;
  if (value === "none") return null;
  const ms = Date.parse(`${value}T00:00:00`);
  return Number.isNaN(ms) ? fail(`Bad date: ${value}`) : ms;
}

const client = new ConvexHttpClient(deploymentUrl());
const key = ownerKey();
const fn = (path: string) => {
  const [mod, name] = path.split(":");
  return anyApi[mod][name];
};
const query = (path: string, args: object = {}) => client.query(fn(path), { ownerKey: key, ...args });
const mutation = async (path: string, args: object = {}) => {
  if (flags["dry-run"]) {
    console.log(`[dry-run] ${path} ${JSON.stringify(args, null, 2)}`);
    process.exit(0);
  }
  if (prod && !flags.yes) fail("Refusing to write to production without --yes.");
  return client.mutation(fn(path), { ownerKey: key, ...args });
};
const print = (value: unknown) => console.log(typeof value === "string" ? value : JSON.stringify(value, null, 2));

type TreeNode = { _id: string; parentNodeId: string | null; position: number; text: string; kind: string; taskStatus: string | null; archived: boolean };

async function loadTree(pageId: string) {
  const result = (await query("workspace:getPageTree", { pageId })) as { page: { title: string }; nodes: TreeNode[] } | null;
  return result ?? fail("Page not found.");
}

// Last visible child under `parent`, so new items append instead of landing on top.
async function lastChildId(pageId: string, parent: string | null) {
  const { nodes } = await loadTree(pageId);
  const siblings = nodes.filter((n) => !n.archived && n.parentNodeId === parent);
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
      return print(await mutation("workspace:createPage", { title: rest.join(" "), ...(flags.section ? { sidebarSection: flags.section } : {}) }));
    case "add": {
      const [pageId, ...text] = rest;
      return print(
        await mutation("workspace:createNode", {
          pageId,
          text: text.join(" "),
          ...(flags.parent ? { parentNodeId: flags.parent } : {}),
          afterNodeId:
            flags.after === "top"
              ? null
              : typeof flags.after === "string"
                ? flags.after
                : await lastChildId(pageId, typeof flags.parent === "string" ? flags.parent : null),
          ...(flags.task || flags.due ? { kind: "task", taskStatus: "todo" } : {}),
          ...(flags.due ? { dueAt: parseDue(flags.due) } : {}),
        }),
      );
    }
    case "add-outline": {
      const [pageId, file] = rest;
      if (!file) fail("Usage: add-outline <pageId> <file|->");
      const nodes = parseOutline(readFileSync(file === "-" ? 0 : file, "utf8"));
      if (!nodes.length) fail("No outline items found.");
      const after = await lastChildId(pageId, null);
      if (after) nodes[0].afterNodeId = after;
      return print(await mutation("workspace:createNodesBatch", { pageId, nodes }));
    }
    case "rename-page":
      await mutation("workspace:renamePage", { pageId: rest[0], title: rest.slice(1).join(" ") });
      return console.log("ok");
    case "update": {
      const args: Record<string, unknown> = { nodeId: rest[0] };
      if (typeof flags.text === "string") args.text = flags.text;
      if (typeof flags.status === "string") args.taskStatus = flags.status;
      if (flags.due !== undefined) args.dueAt = parseDue(flags.due);
      if (flags.task) args.kind = "task";
      if (flags.note) args.kind = "note";
      await mutation("workspace:updateNode", args);
      return console.log("ok");
    }
    case "done":
      await mutation("workspace:updateNode", { nodeId: rest[0], taskStatus: "done" });
      return console.log("ok");
    case "archive":
      await mutation("workspace:archiveNode", { nodeId: rest[0] });
      return console.log("ok");
    case "run": {
      const [kind, path, json] = rest;
      const args = json ? JSON.parse(json) : {};
      return print(kind === "mutation" ? await mutation(path, args) : await query(path, args));
    }
    default:
      console.log(HELP);
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
