/// <reference types="vite/client" />
// parseDraft (Phase 3, change 6): the server reads the app's draft syntax
// when asked; without the flag text is stored as sent (what the app relies on).
import { convexTest } from "convex-test";
import { beforeEach, describe, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
});

async function setup() {
  const t = convexTest(schema, modules);
  const pageId = await t.mutation(api.workspace.createPage, { ownerKey, title: "Tasks", sidebarSection: "Tasks", pageType: "task" });
  const get = (id: Id<"nodes">) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<"nodes">>;
  const create = (text: string, extra: Record<string, unknown> = {}) =>
    t.mutation(api.workspace.createNode, { ownerKey, pageId, text, parentNodeId: null, ...extra });
  return { t, pageId, get, create };
}

describe("parseDraft", () => {
  test("createNode reads checkboxes and keeps dimming", async () => {
    const { get, create } = await setup();
    expect(await get(await create("[ ] buy milk", { parseDraft: true }))).toMatchObject({ text: "buy milk", kind: "task", taskStatus: "todo" });
    expect(await get(await create("%% [x] old", { parseDraft: true }))).toMatchObject({ text: "%% old", kind: "task", taskStatus: "done" });
    expect(await get(await create("just a note", { parseDraft: true }))).toMatchObject({ text: "just a note", kind: "note", taskStatus: null });
    expect(await get(await create("plain task", { parseDraft: true, kind: "task" }))).toMatchObject({ kind: "task", taskStatus: "todo" });
  });

  test("empty text is refused", async () => {
    const { create } = await setup();
    await expect(create("   ", { parseDraft: true })).rejects.toThrow(/empty/);
    await expect(create("[ ]", { parseDraft: true })).rejects.toThrow(/empty/);
  });

  test("without the flag the text is stored as sent", async () => {
    const { get, create } = await setup();
    expect(await get(await create("[ ] literal"))).toMatchObject({ text: "[ ] literal", kind: "note" });
  });

  test("createNodesBatch parses every entry", async () => {
    const { t, pageId } = await setup();
    const created = await t.mutation(api.workspace.createNodesBatch, {
      ownerKey,
      pageId,
      parseDraft: true,
      nodes: [
        { clientId: "a", parentNodeId: null, text: "[ ] parent task" },
        { clientId: "b", parentClientId: "a", text: "[x] finished child" },
        { clientId: "c", parentClientId: "a", text: "a note" },
      ],
    });
    expect(created.map((n) => [n.text, n.kind, n.taskStatus])).toEqual([
      ["parent task", "task", "todo"],
      ["finished child", "task", "done"],
      ["a note", "note", null],
    ]);
    await expect(
      t.mutation(api.workspace.createNodesBatch, { ownerKey, pageId, parseDraft: true, nodes: [{ parentNodeId: null, text: "" }] }),
    ).rejects.toThrow(/empty/);
  });

  test("updateNode: plain text keeps kind and status; a marker changes them", async () => {
    const { t, get, create } = await setup();
    const task = await create("Task", { kind: "task", taskStatus: "done" });
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: task, text: "Renamed", parseDraft: true });
    expect(await get(task)).toMatchObject({ text: "Renamed", kind: "task", taskStatus: "done" });
    const note = await create("Note");
    await t.mutation(api.workspace.updateNode, { ownerKey, nodeId: note, text: "[ ] Now a task", parseDraft: true });
    expect(await get(note)).toMatchObject({ text: "Now a task", kind: "task", taskStatus: "todo" });
    await expect(t.mutation(api.workspace.updateNode, { ownerKey, nodeId: note, text: "", parseDraft: true })).rejects.toThrow(/empty/);
  });
});
