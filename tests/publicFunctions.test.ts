// The public Convex functions, compared with a committed snapshot
// (tests/publicFunctions.snapshot.json).
//
// A deploy updates the backend before the new frontend goes live, and open
// tabs keep running older bundles, so removing (or renaming, or changing the
// kind of) a public function breaks them. Removing one fails here unless it
// first becomes a stub in convex/lib/retiredStubs.ts. See docs/deploying.md.
//
// After adding a function, or deleting a stub past its date, update the
// snapshot: UPDATE_PUBLIC_FUNCTIONS_SNAPSHOT=1 npm run -s test:unit
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { RETIRED_PUBLIC_FUNCTIONS } from "../convex/lib/retiredStubs";

const convexDir = join(process.cwd(), "convex");
const snapshotPath = join(process.cwd(), "tests", "publicFunctions.snapshot.json");

function moduleFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "_generated" ? [] : moduleFiles(path);
    }
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : [];
  });
}

type RegisteredFunction = {
  isPublic?: boolean;
  isQuery?: boolean;
  isMutation?: boolean;
  isAction?: boolean;
};

// "module:name (kind)" for every public query, mutation and action, read from
// the registered functions themselves.
async function listPublicFunctions() {
  const names: string[] = [];
  for (const file of moduleFiles(convexDir)) {
    const modulePath = relative(convexDir, file).replace(/\.ts$/, "").split("\\").join("/");
    const exports = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
    for (const [exportName, value] of Object.entries(exports)) {
      if (typeof value !== "function") continue;
      const fn = value as unknown as RegisteredFunction;
      if (!fn.isPublic) continue;
      const kind = fn.isQuery ? "query" : fn.isMutation ? "mutation" : fn.isAction ? "action" : null;
      if (kind) names.push(`${modulePath}:${exportName} (${kind})`);
    }
  }
  return names.sort();
}

function readSnapshot(): string[] {
  return JSON.parse(readFileSync(snapshotPath, "utf8")) as string[];
}

test("no public Convex function disappears without a retired stub", async () => {
  const current = await listPublicFunctions();
  assert.ok(current.length > 100, `expected the full function list, found ${current.length}`);
  if (process.env.UPDATE_PUBLIC_FUNCTIONS_SNAPSHOT === "1") {
    writeFileSync(snapshotPath, `${JSON.stringify(current, null, 2)}\n`);
  }
  const snapshot = readSnapshot();
  const currentSet = new Set(current);
  const removed = snapshot.filter((name) => !currentSet.has(name));
  assert.deepEqual(
    removed,
    [],
    "These public functions are gone, but open tabs on older builds may still call them. " +
      "Keep each one as a stub in convex/lib/retiredStubs.ts for at least a week (docs/deploying.md). " +
      `Missing: ${removed.join(", ")}`,
  );
  const snapshotSet = new Set(snapshot);
  const added = current.filter((name) => !snapshotSet.has(name));
  assert.deepEqual(
    added,
    [],
    `New public functions: add them to tests/publicFunctions.snapshot.json ` +
      `(UPDATE_PUBLIC_FUNCTIONS_SNAPSHOT=1 npm run -s test:unit). New: ${added.join(", ")}`,
  );
});

test("every retired stub is still a public query under its old name", async () => {
  const current = new Set(await listPublicFunctions());
  for (const [name, entry] of Object.entries(RETIRED_PUBLIC_FUNCTIONS)) {
    assert.ok(current.has(`${name} (query)`), `${name} is listed as retired but isn't registered`);
    assert.match(entry.deleteAfter, /^\d{4}-\d{2}-\d{2}$/, name);
    assert.ok(entry.behavior.length > 10, name);
  }
});
