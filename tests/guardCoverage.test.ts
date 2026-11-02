// Fails when a public mutation in convex/ is neither guarded nor exempt, or
// when a "guarded" one doesn't actually call a guard.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXEMPT_MUTATIONS, GUARDED_MUTATIONS, GUARD_FUNCTION_NAMES } from "../convex/lib/guardRegistry";

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
