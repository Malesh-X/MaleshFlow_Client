import test from "node:test";
import assert from "node:assert/strict";
import { READ_PAGE_MAX_ITEMS, renderPage, ToolError, type FlowCalls } from "../lib/mcp/tools";
import type { PageDoc, TreeNode } from "../lib/flow/logic";

const node = (id: string, parentNodeId: string | null, position: number, text = id, extra: Partial<TreeNode> = {}): TreeNode => ({
  _id: id,
  pageId: "p1",
  parentNodeId,
  position,
  text,
  kind: "note",
  taskStatus: null,
  archived: false,
  ...extra,
});

function fakeFlow(nodes: TreeNode[], page: PageDoc = { _id: "p1", title: "Plan" }, loadWarning: string | null = null): FlowCalls {
  return {
    query: async (path) => {
      if (path === "workspace:getPageTree") return { page, nodes, loadWarning };
      throw new Error("no links in tests");
    },
    mutation: async () => {
      throw new Error("read only");
    },
  };
}

// Sections A, B, C with `per` children each; the children have one grandchild each.
function sectionedPage(per: number) {
  const nodes: TreeNode[] = [];
  for (const [s, name] of ["A", "B", "C"].entries()) {
    nodes.push(node(name, null, s));
    for (let i = 0; i < per; i += 1) {
      nodes.push(node(`${name}${i}`, name, i));
      nodes.push(node(`${name}${i}g`, `${name}${i}`, 0));
    }
  }
  return nodes;
}

const itemLines = (out: string) => out.split("\n").filter((line) => /^\s*- .*\(\w+\)$/.test(line) && !line.includes("item"));

test("a page under the limit prints whole with no note", async () => {
  const out = await renderPage(fakeFlow(sectionedPage(10)), "p1");
  assert.equal(itemLines(out).length, 63);
  assert.doesNotMatch(out, /Showing items/);
  assert.match(out, /^# Plan {2}\(page p1\)\n- A {2}\(A\)\n {2}- A0 {2}\(A0\)\n {4}- A0g {2}\(A0g\)/);
});

test("a long page is batched, continues by offset and prints the ancestor path", async () => {
  const flow = fakeFlow(sectionedPage(100)); // 603 items
  const first = await renderPage(flow, { pageId: "p1" });
  assert.equal(READ_PAGE_MAX_ITEMS, 450);
  assert.match(first, /Showing items 1–450 of 603\. Call read_page with offset=450 for more, or parentId=<id> to read one section\./);
  assert.match(first, /Top-level sections:\n- A {2}\(A\) {2}201 items\n- B {2}\(B\) {2}201 items\n- C {2}\(C\) {2}201 items/);
  assert.equal(first.split("\n").filter((l) => /\((?:[ABC]\d*g?)\)$/.test(l)).length, 450);

  // Item 451 is C23g (A: 201, B: 201, then C, C0, C0g … C23, C23g).
  const second = await renderPage(flow, { pageId: "p1", offset: 450 });
  assert.match(second, /^# Plan {2}\(page p1\)\n\(continuing under: C > C23\)\n {4}- C23g {2}\(C23g\)/);
  assert.doesNotMatch(second, /Showing items/);
  assert.match(second, /- C99g {2}\(C99g\)$/);

  await assert.rejects(renderPage(flow, { pageId: "p1", offset: 603 }), ToolError);
});

test("the character backstop cuts long items between items", async () => {
  const nodes = Array.from({ length: 300 }, (_, i) => node(`n${String(i).padStart(3, "0")}`, null, i, "x".repeat(500)));
  const lineLength = "- ".length + 500 + "  (n000)".length + 1; // 511
  const fits = Math.floor(100_000 / lineLength); // 195
  const out = await renderPage(fakeFlow(nodes), "p1");
  assert.match(out, new RegExp(`Showing items 1–${fits} of 300\\. Call read_page with offset=${fits} for more`));
  const rest = await renderPage(fakeFlow(nodes), { pageId: "p1", offset: fits });
  assert.match(rest, new RegExp(`^# Plan  \\(page p1\\)\\n- x+  \\(n${fits}\\)`));
  assert.doesNotMatch(rest, /Showing items/);
});

test("parentId reads one subtree; an id on another page is refused", async () => {
  const flow = fakeFlow(sectionedPage(10));
  const out = await renderPage(flow, { pageId: "p1", parentId: "B" });
  assert.match(out, /^# Plan {2}\(page p1\)\n- B {2}\(B\)\n {2}- B0 {2}\(B0\)/);
  assert.doesNotMatch(out, /\(A\d*g?\)|\(C\d*g?\)/);
  const sub = await renderPage(flow, { pageId: "p1", parentId: "B3" });
  assert.match(sub, /^# Plan {2}\(page p1\)\n\(under: B\)\n- B3 {2}\(B3\)\n {2}- B3g {2}\(B3g\)$/);
  await assert.rejects(renderPage(flow, { pageId: "p1", parentId: "elsewhere" }), /parentId must be an active item on this page/);

  const big = await renderPage(fakeFlow(sectionedPage(300)), { pageId: "p1", parentId: "A" });
  assert.match(big, /Showing items 1–450 of 601\. Call read_page with pageId=p1, parentId=A, offset=450/);
  assert.match(big, /Sections in this item:\n- A0 {2}\(A0\) {2}2 items/);
});

test("strays and the load warning appear only on the last batch", async () => {
  const nodes = [...sectionedPage(100), node("lost", "gone", 0), node("lostKid", "lost", 0)];
  const flow = fakeFlow(nodes, { _id: "p1", title: "Plan" }, "This page is too large to load fully right now, so only the first portion is shown.");
  const first = await renderPage(flow, "p1");
  assert.doesNotMatch(first, /Stray items/);
  assert.match(first, /Note: This page is too large/);
  const last = await renderPage(flow, { pageId: "p1", offset: 450 });
  assert.match(last, /## Stray items \(1\).*\n- lost {2}\(lost\)\n {2}- lostKid {2}\(lostKid\)/);
  assert.match(last, /Note: This page is too large/);
});

test("Past Weeks lists its weeks newest first", async () => {
  const nodes = [
    node("old", null, 0, "Week 1", { sourceMeta: { archivedAt: 100 } }),
    node("new", null, 1, "Week 2", { sourceMeta: { archivedAt: 200 } }),
  ];
  const out = await renderPage(fakeFlow(nodes, { _id: "p1", title: "Past Weeks", archived: true, sourceMeta: { archivedPurpose: "plannerHistory" } }), "p1");
  assert.match(out, /- Week 2 {2}\(new\)\n- Week 1 {2}\(old\)/);
});
