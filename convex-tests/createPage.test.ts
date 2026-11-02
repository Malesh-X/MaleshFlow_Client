/// <reference types="vite/client" />
// createPage without a page type (Phase 3, change 5): the section decides it,
// the way the app's + button does, and the page gets that type's sections.
import { convexTest } from "convex-test";
import { beforeEach, expect, test } from "vitest";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import schema from "../convex/schema";
import { SIDEBAR_SECTIONS, getPageMeta, pageTypeForSection, primarySectionSlot } from "../lib/domain/workspaceRules";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);
const ownerKey = "test-owner-key";

beforeEach(() => {
  process.env.OWNER_ACCESS_TOKEN = ownerKey;
});

test.each(SIDEBAR_SECTIONS.map((section) => [section]))("a %s page without a type gets the section's type and sections", async (section) => {
  const t = convexTest(schema, modules);
  const pageId = await t.mutation(api.workspace.createPage, { ownerKey, title: `New ${section}`, sidebarSection: section });
  const page = (await t.run((ctx) => ctx.db.get(pageId)))!;
  expect((page.sourceMeta as { pageType?: string }).pageType).toBe(pageTypeForSection(section));
  const slot = primarySectionSlot(page);
  if (slot !== "root" && slot !== "requireParent") {
    const roots = await t.run((ctx) =>
      ctx.db
        .query("nodes")
        .withIndex("by_page_parent_position", (q) => q.eq("pageId", pageId as Id<"pages">).eq("parentNodeId", null))
        .collect(),
    );
    expect(roots.some((node) => (node.sourceMeta as { sectionSlot?: string })?.sectionSlot === slot)).toBe(true);
  }
});

test("an explicit type still wins, and planner is accepted", async () => {
  const t = convexTest(schema, modules);
  const plain = await t.mutation(api.workspace.createPage, { ownerKey, title: "Plain", sidebarSection: "Notes", pageType: "default" });
  const planner = await t.mutation(api.workspace.createPage, { ownerKey, title: "Week", sidebarSection: "Tasks", pageType: "planner" });
  const noSection = await t.mutation(api.workspace.createPage, { ownerKey, title: "Loose" });
  const get = (id: Id<"pages">) => t.run((ctx) => ctx.db.get(id));
  // Stored as given (getPageMeta would read a default Notes page as a note page).
  expect(((await get(plain))!.sourceMeta as { pageType?: string }).pageType).toBe("default");
  expect(getPageMeta(await get(planner)).pageType).toBe("planner");
  // No section means Tasks, which makes a task page.
  expect(getPageMeta(await get(noSection))).toMatchObject({ sidebarSection: "Tasks", pageType: "task" });
});
