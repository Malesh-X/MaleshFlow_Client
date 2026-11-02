import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Every context WorkspaceApp reads must have its provider rendered. A missing
// NodeCompletionContext.Provider broke every checkbox in prod ("Completion is
// not available here.").
test("every context used in WorkspaceApp has a rendered provider", () => {
  const source = readFileSync(new URL("../components/WorkspaceApp.tsx", import.meta.url), "utf8");
  const contexts = [...source.matchAll(/const (\w+Context) = createContext/g)].map((m) => m[1]);
  assert.ok(contexts.includes("NodeCompletionContext"));
  for (const name of contexts) {
    if (!source.includes(`useContext(${name})`)) continue;
    assert.ok(source.includes(`<${name}.Provider`), `${name} is read but never provided`);
  }
});
