// Fails when a public mutation in convex/ is neither guarded nor exempt, or
// when a "guarded" one doesn't actually call a guard.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXEMPT_MUTATIONS, GUARDED_MUTATIONS, GUARD_FUNCTION_NAMES } from "../convex/lib/guardRegistry";
import { AGENT_FUNCTIONS, AGENT_HIDING_FUNCTION_NAMES, type AgentEntry } from "../convex/lib/agentRegistry";
import { RETIRED_PUBLIC_FUNCTIONS } from "../convex/lib/retiredStubs";

// Tests run from the repo root (npm test).
const convexDir = join(process.cwd(), "convex");
const sources = Object.fromEntries(
  readdirSync(convexDir)
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".d.ts"))
    .map((file) => [file.slice(0, -3), readFileSync(join(convexDir, file), "utf8")]),
);

// The source of each `export const name = mutation({...})`, up to the next export.
function mutationBlocks() {
  const blocks = new Map<string, string>();
  for (const [module, source] of Object.entries(sources)) {
    const matches = [...source.matchAll(/^export const (\w+) = (mutation|internalMutation|query|internalQuery|action|internalAction|httpAction)\(/gm)];
    matches.forEach((match, index) => {
      if (match[2] !== "mutation") return;
      const end = matches[index + 1]?.index ?? source.length;
      blocks.set(`${module}:${match[1]}`, source.slice(match.index, end));
    });
  }
  return blocks;
}

function functionBody(name: string) {
  for (const source of Object.values(sources)) {
    const start = source.search(new RegExp(`^async function ${name}\\(`, "m"));
    if (start === -1) continue;
    const next = source.slice(start + 1).search(/^(async )?function |^export /m);
    return source.slice(start, next === -1 ? undefined : start + 1 + next);
  }
  return "";
}

const callsGuard = (source: string) => GUARD_FUNCTION_NAMES.some((name) => source.includes(`${name}(ctx`));

test("every public mutation is guarded or exempt, never both", () => {
  const blocks = mutationBlocks();
  assert.ok(blocks.size > 50, `expected the full mutation list, found ${blocks.size}`);
  const missing = [...blocks.keys()].filter((name) => !(name in GUARDED_MUTATIONS) && !(name in EXEMPT_MUTATIONS));
  assert.deepEqual(missing, [], `Add these to convex/lib/guardRegistry.ts: ${missing.join(", ")}`);
  const both = Object.keys(GUARDED_MUTATIONS).filter((name) => name in EXEMPT_MUTATIONS);
  assert.deepEqual(both, []);
  const stale = [...Object.keys(GUARDED_MUTATIONS), ...Object.keys(EXEMPT_MUTATIONS)].filter((name) => !blocks.has(name));
  assert.deepEqual(stale, [], `Not public mutations (remove from the registry): ${stale.join(", ")}`);
});

test("every exemption has a reason", () => {
  for (const [name, reason] of Object.entries(EXEMPT_MUTATIONS)) assert.ok(reason.length > 10, name);
});

test("every public mutation wraps its ctx with withGuards under its own name", () => {
  for (const [name, block] of mutationBlocks()) {
    assert.ok(block.includes(`const ctx = withGuards(rawCtx, "${name}");`), `${name} doesn't start with withGuards`);
  }
});

test("every guarded mutation calls a guard", () => {
  const blocks = mutationBlocks();
  for (const [name, entry] of Object.entries(GUARDED_MUTATIONS)) {
    const block = blocks.get(name) ?? "";
    const viaBodies = (entry.via ?? []).map(functionBody);
    for (const [index, body] of viaBodies.entries()) assert.ok(body.length > 0, `${name}: helper ${entry.via![index]} not found`);
    assert.ok(callsGuard(block) || viaBodies.some(callsGuard), `${name} is listed as guarded but calls no guard`);
  }
});

// ---- agent tokens (convex/lib/agentRegistry.ts) ----

// Every public query, mutation and action, by "module:name".
function publicBlocks() {
  const blocks = new Map<string, string>();
  for (const [module, source] of Object.entries(sources)) {
    const matches = [...source.matchAll(/^export const (\w+) = (mutation|internalMutation|query|internalQuery|action|internalAction|httpAction)\(/gm)];
    matches.forEach((match, index) => {
      if (!["mutation", "query", "action"].includes(match[2])) return;
      const end = matches[index + 1]?.index ?? source.length;
      blocks.set(`${module}:${match[1]}`, source.slice(match.index, end));
    });
  }
  return blocks;
}

// Public functions that take no owner key at all: the OAuth endpoints
// (each checks its own code, token or the owner key) and the owner-key check.
const NO_OWNER_KEY = new Set([
  "oauth:registerClient",
  "oauth:getClient",
  "oauth:approve",
  "oauth:exchangeCode",
  "oauth:refresh",
  "oauth:authenticate",
  "workspace:checkOwnerKey",
]);
const OWNER_KEY_CHECK = /assertOwnerKey(Guarded|GuardedInAction)?\(/;

test("only allowlisted functions accept agent tokens, each under its own name", () => {
  const blocks = publicBlocks();
  for (const [name, block] of blocks) {
    const calls = [...block.matchAll(/authorizeCaller\([^,]+,[^,]+,\s*"([^"]+)"\)/g)].map((match) => match[1]);
    if (name in AGENT_FUNCTIONS) {
      assert.deepEqual(calls, [name], `${name} must call authorizeCaller once with its own name`);
      assert.ok(!OWNER_KEY_CHECK.test(block), `${name} must check its caller with authorizeCaller only`);
    } else {
      assert.ok(!block.includes("authorizeCaller("), `${name} accepts agent tokens but isn't in AGENT_FUNCTIONS`);
    }
  }
  const stale = Object.keys(AGENT_FUNCTIONS).filter((name) => !blocks.has(name));
  assert.deepEqual(stale, [], `Not public functions (remove from AGENT_FUNCTIONS): ${stale.join(", ")}`);
});

test("every function that accepts agent tokens applies the data dump hiding rule", () => {
  const blocks = publicBlocks();
  for (const [name, entry] of Object.entries(AGENT_FUNCTIONS) as [string, AgentEntry][]) {
    if (entry.noContent) continue;
    const block = blocks.get(name) ?? "";
    assert.ok(
      AGENT_HIDING_FUNCTION_NAMES.some((helper) => block.includes(`${helper}(`)),
      `${name} accepts agent tokens but calls none of ${AGENT_HIDING_FUNCTION_NAMES.join(", ")}`,
    );
  }
});

test("every other public function checks the owner key, which refuses agent tokens", () => {
  for (const [name, block] of publicBlocks()) {
    if (name in AGENT_FUNCTIONS || NO_OWNER_KEY.has(name)) continue;
    // Retired stubs return the same constant to everyone (convex/lib/retiredStubs.ts).
    if (name in RETIRED_PUBLIC_FUNCTIONS) {
      assert.match(block, /= query\(retiredNullQuery\);/, `${name} is retired but isn't a retiredNullQuery stub`);
      continue;
    }
    assert.ok(OWNER_KEY_CHECK.test(block), `${name} doesn't check the owner key`);
  }
  const auth = readFileSync(join(convexDir, "lib", "auth.ts"), "utf8");
  assert.ok(/if \(isAgentCredential\(ownerKey\)\) \{\s*throw/.test(auth), "assertOwnerKey must refuse agent tokens first");
});

test("agents can't change exclusions, settings, auth or tokens, or delete pages", () => {
  const forbidden = /DataDumpExcluded|setWorkspaceSettings|OwnerKey|^oauth:|delete|Forever|archivePage|setNodeTreeArchived|rebuildEmbeddings/;
  const allowed = Object.keys(AGENT_FUNCTIONS).filter((name) => forbidden.test(name));
  assert.deepEqual(allowed, []);
});
