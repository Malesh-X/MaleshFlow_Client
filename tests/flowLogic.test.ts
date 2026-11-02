import test from "node:test";
import assert from "node:assert/strict";
import { dateInputValueToTimestamp } from "../lib/domain/recurrence";
import {
  classifyStrayParent,
  collectDescendantIds,
  createPageArgs,
  endNotAfterDue,
  findSectionNode,
  findStrayNodes,
  getPageMeta,
  isNodeCompleted,
  isNodeLocked,
  isPlannerCompletionItem,
  isUntypedSectionPage,
  kindChangeArgs,
  nodeChecks,
  noteHasTaskStatus,
  pageTypeForSection,
  parseDueDate,
  primarySectionSlot,
  recurringWithoutDue,
  scheduleForDue,
  validateParent,
  type PageDoc,
  type TreeNode,
} from "../scripts/flowLogic";

let counter = 0;
function node(overrides: Partial<TreeNode> = {}): TreeNode {
  counter += 1;
  return {
    _id: `n${counter}`,
    pageId: "p1",
    parentNodeId: null,
    position: counter * 1024,
    text: `item ${counter}`,
    kind: "note",
    taskStatus: null,
    archived: false,
    dueAt: null,
    dueEndAt: null,
    sourceMeta: {},
    ...overrides,
  };
}
const page = (sourceMeta: Record<string, unknown>, title = "Page"): PageDoc => ({ _id: "p1", title, sourceMeta });

// ---- page types ----

test("pageTypeForSection matches the app's sidebar + button", () => {
  assert.equal(pageTypeForSection("Models"), "model");
  assert.equal(pageTypeForSection("Tasks"), "task");
  assert.equal(pageTypeForSection("Notes"), "note");
  assert.equal(pageTypeForSection("Views"), "multiPage");
  assert.equal(pageTypeForSection("Journal"), "journal");
  assert.equal(pageTypeForSection("Scratchpads"), "scratchpad");
  assert.equal(pageTypeForSection("Templates"), "default");
});

test("createPageArgs adds the journal view flag and supports planner pages", () => {
  assert.deepEqual(createPageArgs("2026-11-02", "Journal"), {
    title: "2026-11-02",
    sidebarSection: "Journal",
    pageType: "journal",
    addToLatestJournalView: true,
  });
  assert.deepEqual(createPageArgs("Ideas", "Notes"), { title: "Ideas", sidebarSection: "Notes", pageType: "note" });
  assert.deepEqual(createPageArgs("Week", "Tasks", "planner"), { title: "Week", sidebarSection: "Tasks", pageType: "planner" });
});

test("getPageMeta falls back on the sidebar section like the app", () => {
  assert.deepEqual(getPageMeta(page({ sidebarSection: "Notes", pageType: "default" })), { pageType: "note", sidebarSection: "Notes" });
  assert.deepEqual(getPageMeta(page({ sidebarSection: "Tasks" })), { pageType: "task", sidebarSection: "Tasks" });
  assert.deepEqual(getPageMeta(page({ pageType: "planner" })), { pageType: "planner", sidebarSection: "Tasks" });
  assert.deepEqual(getPageMeta(page({ specialPage: "sidebar" })), { pageType: "note", sidebarSection: "Notes" });
  assert.deepEqual(getPageMeta(page({ sidebarSection: "Models", pageType: "default" })), { pageType: "default", sidebarSection: "Models" });
});

test("primarySectionSlot picks the section the app adds into", () => {
  assert.equal(primarySectionSlot(page({ pageType: "planner" })), "requireParent");
  assert.equal(primarySectionSlot(page({ pageType: "note" })), "noteMain");
  assert.equal(primarySectionSlot(page({ sidebarSection: "Notes" })), "noteMain");
  assert.equal(primarySectionSlot(page({ pageType: "journal" })), "journalThoughts");
  assert.equal(primarySectionSlot(page({ pageType: "scratchpad" })), "scratchpadLive");
  assert.equal(primarySectionSlot(page({ pageType: "model" })), "model");
  assert.equal(primarySectionSlot(page({ pageType: "multiPage" })), "multiPageIncludedPages");
  assert.equal(primarySectionSlot(page({ sidebarSection: "Templates", pageType: "default" })), "templateMain");
  assert.equal(primarySectionSlot(page({ pageType: "task" })), "root");
  assert.equal(primarySectionSlot(page({ sidebarSection: "Models", pageType: "default" })), "root");
});

test("findSectionNode finds an active root section by slot", () => {
  const section = node({ sourceMeta: { sectionSlot: "noteMain", locked: true } });
  const archived = node({ archived: true, sourceMeta: { sectionSlot: "noteArchive", locked: true } });
  const nested = node({ parentNodeId: section._id, sourceMeta: { sectionSlot: "noteArchive" } });
  assert.equal(findSectionNode([section, archived, nested], "noteMain"), section);
  assert.equal(findSectionNode([section, archived, nested], "noteArchive"), null);
});

test("isUntypedSectionPage flags default pages in typed sections only", () => {
  assert.equal(isUntypedSectionPage(page({ sidebarSection: "Models", pageType: "default" })), true);
  assert.equal(isUntypedSectionPage(page({ sidebarSection: "Journal" })), true);
  assert.equal(isUntypedSectionPage(page({ sidebarSection: "Views", pageType: "multiPage" })), false);
  assert.equal(isUntypedSectionPage(page({ sidebarSection: "Notes", pageType: "default" })), false);
  assert.equal(isUntypedSectionPage(page({ sidebarSection: "Templates", pageType: "default" })), false);
  assert.equal(isUntypedSectionPage(page({ sidebarSection: "Tasks", pageType: "default" })), false);
});

// ---- nodes ----

test("isNodeLocked matches section headers and planner days", () => {
  assert.equal(isNodeLocked(node({ sourceMeta: { locked: true, sectionSlot: "noteMain" } })), true);
  assert.equal(isNodeLocked(node({ sourceMeta: { locked: true, plannerKind: "plannerDay" } })), true);
  assert.equal(isNodeLocked(node({ sourceMeta: { locked: true } })), false);
  assert.equal(isNodeLocked(node({ sourceMeta: { sectionSlot: "noteMain" } })), false);
  assert.equal(isNodeLocked(node({ sourceMeta: null })), false);
});

test("isNodeCompleted reads task status or the note completed flag", () => {
  assert.equal(isNodeCompleted(node({ kind: "task", taskStatus: "done" })), true);
  assert.equal(isNodeCompleted(node({ kind: "task", taskStatus: "todo" })), false);
  assert.equal(isNodeCompleted(node({ sourceMeta: { noteCompleted: true } })), true);
  assert.equal(isNodeCompleted(node()), false);
});

test("isPlannerCompletionItem finds planner day ancestors and stops on cycles", () => {
  const day = node({ sourceMeta: { plannerKind: "plannerDay", locked: true } });
  const item = node({ parentNodeId: day._id, kind: "task", taskStatus: "todo" });
  const child = node({ parentNodeId: item._id });
  const plain = node();
  const a = node({ parentNodeId: "loopB" });
  const b = { ...node({ parentNodeId: a._id }), _id: "loopB" };
  const nodeMap = new Map([day, item, child, plain, a, b].map((n) => [n._id, n]));
  const map = (id: string) => nodeMap.get(id);
  assert.equal(isPlannerCompletionItem(item, map), true);
  assert.equal(isPlannerCompletionItem(child, map), true);
  assert.equal(isPlannerCompletionItem(plain, map), false);
  assert.equal(isPlannerCompletionItem(a, map), false);
  assert.equal(isPlannerCompletionItem(node({ sourceMeta: { plannerKind: "plannerLinkedTask", sourceTaskNodeId: "x" } }), map), true);
});

// ---- parent and cycle validation ----

test("collectDescendantIds returns the whole branch", () => {
  const root = node();
  const child = node({ parentNodeId: root._id });
  const grandchild = node({ parentNodeId: child._id });
  const other = node();
  assert.deepEqual([...collectDescendantIds([root, child, grandchild, other], root._id)].sort(), [child._id, grandchild._id].sort());
  assert.equal(collectDescendantIds([root, child], other._id).size, 0);
});

test("validateParent refuses self, descendants and parents off the target page", () => {
  const root = node();
  const child = node({ parentNodeId: root._id });
  const grandchild = node({ parentNodeId: child._id });
  const sibling = node();
  const nodes = [root, child, grandchild, sibling];
  const descendantIds = collectDescendantIds(nodes, root._id);
  assert.equal(validateParent({ nodeId: root._id, parentId: null, targetNodes: nodes, descendantIds }), null);
  assert.equal(validateParent({ nodeId: root._id, parentId: sibling._id, targetNodes: nodes, descendantIds }), null);
  assert.match(validateParent({ nodeId: root._id, parentId: root._id, targetNodes: nodes, descendantIds }) ?? "", /own parent/);
  assert.match(validateParent({ nodeId: root._id, parentId: grandchild._id, targetNodes: nodes, descendantIds }) ?? "", /loop/);
  assert.match(validateParent({ nodeId: root._id, parentId: "elsewhere", targetNodes: nodes, descendantIds }) ?? "", /destination page/);
  assert.equal(validateParent({ nodeId: null, parentId: sibling._id, targetNodes: nodes }), null);
});

// ---- schedules ----

test("parseDueDate stores local noon like the app's date picker", () => {
  assert.equal(parseDueDate(undefined), undefined);
  assert.equal(parseDueDate("none"), null);
  const ms = parseDueDate("2026-11-15");
  assert.equal(ms, dateInputValueToTimestamp("2026-11-15"));
  assert.equal(new Date(ms!).getHours(), 12);
  assert.throws(() => parseDueDate("2026-02-31"), /Bad date/);
  assert.throws(() => parseDueDate("11/15/2026"), /Bad date/);
});

test("scheduleForDue clears all five fields on none", () => {
  assert.deepEqual(scheduleForDue(null, { dueEndAt: 5 }), {
    dueAt: null,
    dueEndAt: null,
    dueTime: null,
    dueTimeZone: null,
    recurrenceFrequency: null,
  });
});

test("scheduleForDue drops an end date that isn't after the new due date", () => {
  assert.deepEqual(scheduleForDue(100, { dueEndAt: 50 }), { dueAt: 100, dueEndAt: null });
  assert.deepEqual(scheduleForDue(100, { dueEndAt: 100 }), { dueAt: 100, dueEndAt: null });
  assert.deepEqual(scheduleForDue(100, { dueEndAt: 200 }), { dueAt: 100 });
  assert.deepEqual(scheduleForDue(100, {}), { dueAt: 100 });
});

test("kindChangeArgs matches the app's task/note toggle and always locks", () => {
  const note = node({ dueAt: 5 });
  assert.deepEqual(kindChangeArgs(note, "task"), {
    kind: "task",
    lockKind: true,
    taskStatus: "todo",
    noteCompleted: false,
    dueAt: null,
    dueEndAt: null,
    recurrenceFrequency: null,
  });
  assert.equal(kindChangeArgs(node({ kind: "task", taskStatus: "done" }), "note").taskStatus, null);
  assert.deepEqual(kindChangeArgs(node({ kind: "task" }), "task"), { kind: "task", lockKind: true });
});

// ---- stray items and doctor checks ----

test("findStrayNodes lists active nodes whose parent isn't active on the page", () => {
  const root = node();
  const child = node({ parentNodeId: root._id });
  const archivedParent = node({ archived: true });
  const underArchived = node({ parentNodeId: archivedParent._id });
  const underMissing = node({ parentNodeId: "gone" });
  const archivedStray = node({ parentNodeId: "gone", archived: true });
  assert.deepEqual(
    findStrayNodes([root, child, archivedParent, underArchived, underMissing, archivedStray]).map((n) => n._id),
    [underArchived._id, underMissing._id],
  );
});

test("classifyStrayParent explains why a parent can't be used", () => {
  assert.equal(classifyStrayParent("p1", null), "missing");
  assert.equal(classifyStrayParent("p1", { pageId: null, archived: false }), "missing");
  assert.equal(classifyStrayParent("p1", { pageId: "p2", archived: false }), "otherPage");
  assert.equal(classifyStrayParent("p1", { pageId: "p1", archived: true }), "archived");
  assert.equal(classifyStrayParent("p1", { pageId: "p1", archived: false }), "notLoaded");
});

test("doctor node checks", () => {
  const statusNote = node({ taskStatus: "todo" });
  const task = node({ kind: "task", taskStatus: "todo", dueAt: 100, dueEndAt: 200 });
  const recurringNoDue = node({ kind: "task", taskStatus: "todo", sourceMeta: { recurrenceFrequency: "daily" } });
  const recurringWithDue = node({ kind: "task", taskStatus: "todo", dueAt: 100, sourceMeta: { recurrenceFrequency: "daily" } });
  const endBeforeDue = node({ kind: "task", taskStatus: "todo", dueAt: 200, dueEndAt: 100 });
  const endWithoutDue = node({ kind: "task", taskStatus: "todo", dueEndAt: 100 });
  const archivedBad = node({ taskStatus: "todo", archived: true });

  assert.equal(noteHasTaskStatus(statusNote), true);
  assert.equal(noteHasTaskStatus(task), false);
  assert.equal(noteHasTaskStatus(archivedBad), false);
  assert.equal(recurringWithoutDue(recurringNoDue), true);
  assert.equal(recurringWithoutDue(recurringWithDue), false);
  assert.equal(endNotAfterDue(endBeforeDue), true);
  assert.equal(endNotAfterDue(endWithoutDue), true);
  assert.equal(endNotAfterDue(task), false);

  const result = nodeChecks(page({}, "Inbox"), [statusNote, task, recurringNoDue, recurringWithDue, endBeforeDue, endWithoutDue, archivedBad]);
  assert.deepEqual(result.notesWithTaskStatus.map((f) => f.nodeId), [statusNote._id]);
  assert.deepEqual(result.recurringWithoutDue.map((f) => f.nodeId), [recurringNoDue._id]);
  assert.deepEqual(result.endNotAfterDue.map((f) => f.nodeId), [endBeforeDue._id, endWithoutDue._id]);
  assert.equal(result.notesWithTaskStatus[0].pageTitle, "Inbox");
});
