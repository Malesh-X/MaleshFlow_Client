/// <reference types="vite/client" />
// Resolve Empty Links: the server never rewrites links inside the target node
// itself, and skipped self-links never keep a batch run going.
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
});

async function setup() {
  const t = convexTest(schema, modules);
  const pageId = await t.mutation(api.workspace.createPage, { ownerKey, title: "Notes", sidebarSection: "Tasks", pageType: "task" });
  const add = (text: string, parentNodeId: Id<"nodes"> | null = null) =>
    t.mutation(api.workspace.createNode, { ownerKey, pageId, text, parentNodeId });
  const textOf = (nodeId: Id<"nodes">) =>
    t.run(async (ctx) => (await ctx.db.get(nodeId))!.text);
  const groups = () => t.query(api.workspace.listUnresolvedPageLinkGroups, { ownerKey });
  return { t, add, textOf, groups };
}

test("a self-only target is left unchanged by both entry points", async () => {
  const { t, add, textOf, groups } = await setup();
  const a = await add("Read about [[topic]] and [[Topic]] again");

  const before = await groups();
  expect(before.groups).toHaveLength(1);
  expect(before.groups[0]!.soleSourceNodeId).toBe(a);

  const viaTarget = await t.mutation(api.workspace.replaceUnresolvedPageLinksWithTarget, {
    ownerKey,
    normalizedTitle: "topic",
    target: { kind: "node", nodeId: a },
  });
  expect(viaTarget).toMatchObject({
    replacedNodeCount: 0,
    replacedOccurrenceCount: 0,
    hasMore: false,
    skippedSelfLink: { nodeId: a, occurrenceCount: 2 },
  });

  const viaNode = await t.mutation(api.workspace.replaceUnresolvedPageLinksWithNode, {
    ownerKey,
    normalizedTitle: "topic",
    targetNodeId: a,
  });
  expect(viaNode).toMatchObject({
    replacedNodeCount: 0,
    hasMore: false,
    skippedSelfLink: { nodeId: a, occurrenceCount: 2 },
  });

  expect(await textOf(a)).toBe("Read about [[topic]] and [[Topic]] again");
  // The label stays listed so it can still be resolved to another target.
  expect((await groups()).groups.map((group) => group.normalizedTitle)).toEqual(["topic"]);
});

test("a target that is one of several sources resolves the others only", async () => {
  for (const entry of ["target", "node"] as const) {
    const { t, add, textOf, groups } = await setup();
    const a = await add("Hub for [[topic]]");
    const b = await add("See [[topic]]");
    const c = await add("Also [[topic]] and [[topic]]");

    expect((await groups()).groups[0]!.soleSourceNodeId).toBeNull();

    const result = entry === "target"
      ? await t.mutation(api.workspace.replaceUnresolvedPageLinksWithTarget, {
          ownerKey,
          normalizedTitle: "topic",
          target: { kind: "node", nodeId: a },
        })
      : await t.mutation(api.workspace.replaceUnresolvedPageLinksWithNode, {
          ownerKey,
          normalizedTitle: "topic",
          targetNodeId: a,
        });

    expect(result).toMatchObject({
      replacedNodeCount: 2,
      replacedOccurrenceCount: 3,
      skippedSelfLink: { nodeId: a, occurrenceCount: 1 },
    });
    expect(await textOf(a)).toBe("Hub for [[topic]]");
    expect(await textOf(b)).not.toContain("[[topic]]");
    expect(await textOf(b)).toContain(a);
    expect(await textOf(c)).toContain(a);

    // Only the target's own link is left, so the group now has one source.
    const after = await groups();
    expect(after.groups[0]).toMatchObject({ nodeCount: 1, soleSourceNodeId: a });
  }
});

test("skipped self-links never use batch slots or keep hasMore true", async () => {
  const { t, add, textOf } = await setup();
  // The target comes first in scan order, so it would take a slot if counted.
  const a = await add("Hub for [[topic]]");
  const others = [
    await add("One [[topic]]"),
    await add("Two [[topic]]"),
    await add("Three [[topic]]"),
  ];

  const run = () =>
    t.mutation(api.workspace.replaceUnresolvedPageLinksWithTarget, {
      ownerKey,
      normalizedTitle: "topic",
      target: { kind: "node", nodeId: a },
      batchSize: 2,
    });

  const first = await run();
  expect(first).toMatchObject({ replacedNodeCount: 2, hasMore: true, skippedSelfLink: { nodeId: a, occurrenceCount: 1 } });
  const second = await run();
  expect(second).toMatchObject({ replacedNodeCount: 1, hasMore: false, skippedSelfLink: { nodeId: a, occurrenceCount: 1 } });
  const third = await run();
  expect(third).toMatchObject({ replacedNodeCount: 0, hasMore: false, skippedSelfLink: { nodeId: a, occurrenceCount: 1 } });

  for (const nodeId of others) {
    expect(await textOf(nodeId)).toContain(a);
  }
  expect(await textOf(a)).toBe("Hub for [[topic]]");
});

test("page targets keep their current behavior", async () => {
  const { t, add, textOf } = await setup();
  const target = await t.mutation(api.workspace.createPage, { ownerKey, title: "Elsewhere", sidebarSection: "Tasks", pageType: "task" });
  const a = await add("See [[topic]]");

  const result = await t.mutation(api.workspace.replaceUnresolvedPageLinksWithTarget, {
    ownerKey,
    normalizedTitle: "topic",
    target: { kind: "page", pageId: target },
  });
  expect(result).toMatchObject({ replacedNodeCount: 1, skippedSelfLink: null });
  expect(await textOf(a)).toContain(target);
});
