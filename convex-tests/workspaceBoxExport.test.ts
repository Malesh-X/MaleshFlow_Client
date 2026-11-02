/// <reference types="vite/client" />
// The Inbox and Random Box features are gone, but their saved text still goes
// into the data dump, read straight from the sidebar page's metadata.
import { convexTest } from "convex-test";
import { expect, test } from "vitest";
import { internal } from "../convex/_generated/api";
import schema from "../convex/schema";

const modules = import.meta.glob(["../convex/**/*.ts", "!../convex/**/*.d.ts", "../convex/_generated/*.js"]);

async function dumpWithSidebarMeta(sourceMeta: Record<string, unknown>) {
  const t = convexTest(schema, modules);
  await t.run(async (ctx) => {
    await ctx.db.insert("pages", {
      title: "Sidebar",
      slug: "sidebar",
      icon: null,
      archived: false,
      position: -1024,
      sourceMeta: {
        sourceType: "system",
        specialPage: "sidebar",
        hidden: true,
        pageType: "note",
        sidebarSection: "Notes",
        ...sourceMeta,
      },
      createdAt: 1,
      updatedAt: 1,
    });
  });
  const bundle = await t.query(internal.importExportData.buildDataDumpBundle, {});
  return new Map(bundle.files.map((file) => [file.path, file.content]));
}

test("saved multi-box Inbox and Random Box text stays in the data dump", async () => {
  const files = await dumpWithSidebarMeta({
    workspaceInboxText: "first inbox",
    workspaceInboxTexts: ["first inbox", "second inbox", "third inbox"],
    workspaceRandomBoxText: "apples",
    workspaceRandomBoxTexts: ["apples\npears", "plums"],
  });

  expect(files.get("workspace/inbox.md")).toBe(
    "# Workspace Inbox\n\n## Box 1\n\nfirst inbox\n\n## Box 2\n\nsecond inbox\n\n## Box 3\n\nthird inbox\n",
  );
  expect(files.get("workspace/random-box.md")).toBe(
    "# Workspace Random Box\n\n## Box 1\n\napples\npears\n\n## Box 2\n\nplums\n",
  );
});

test("legacy single-box text is exported as the first box", async () => {
  const files = await dumpWithSidebarMeta({
    workspaceInboxText: "old inbox",
    workspaceRandomBoxText: "old random",
  });

  expect(files.get("workspace/inbox.md")).toBe(
    "# Workspace Inbox\n\n## Box 1\n\nold inbox\n\n## Box 2\n",
  );
  expect(files.get("workspace/random-box.md")).toBe(
    "# Workspace Random Box\n\n## Box 1\n\nold random\n\n## Box 2\n",
  );
});
