// Workspace-wide settings, stored on the hidden Sidebar page's sourceMeta
// (next to the AI memory text): the workspace time zone used for date math.
// Deprecated: sourceMeta.workspaceCompletionMode may still be stored there
// from older versions; nothing reads or writes it now.
import type { Doc } from "../_generated/dataModel";
import type { DatabaseReader, MutationCtx } from "../_generated/server";
import { isValidTimeZone } from "../../lib/domain/timeZone";
import { buildUniquePageSlug } from "./workspace";

export type WorkspaceSettings = {
  timeZone: string | null;
};

const metaOf = (page: Pick<Doc<"pages">, "sourceMeta"> | null) =>
  page && typeof page.sourceMeta === "object" && page.sourceMeta ? (page.sourceMeta as Record<string, unknown>) : {};

async function findSidebarPage(db: DatabaseReader) {
  const pages = await db
    .query("pages")
    .withIndex("by_archived_position", (query) => query.eq("archived", false))
    .take(500);
  return pages.find((page) => metaOf(page).specialPage === "sidebar") ?? null;
}

export async function readWorkspaceSettings(db: DatabaseReader): Promise<WorkspaceSettings> {
  const meta = metaOf(await findSidebarPage(db));
  return {
    timeZone: isValidTimeZone(meta.workspaceTimeZone) ? meta.workspaceTimeZone : null,
  };
}

// The zone server-side date math uses for an item: its own zone when set,
// otherwise the workspace zone, otherwise UTC.
export async function workspaceTimeZoneFor(db: DatabaseReader, item?: { dueTimeZone?: string | null } | null) {
  if (isValidTimeZone(item?.dueTimeZone)) return item!.dueTimeZone!;
  return (await readWorkspaceSettings(db)).timeZone ?? "UTC";
}

export async function writeWorkspaceSettings(ctx: MutationCtx, patch: Partial<WorkspaceSettings>) {
  const sidebarPage = await findSidebarPage(ctx.db);
  const now = Date.now();
  const next: Record<string, unknown> = {};
  if (patch.timeZone !== undefined) next.workspaceTimeZone = patch.timeZone;
  if (!sidebarPage) {
    await ctx.db.insert("pages", {
      title: "Sidebar",
      slug: await buildUniquePageSlug(ctx.db, "Sidebar"),
      icon: null,
      archived: false,
      position: -1024,
      sourceMeta: { sourceType: "system", specialPage: "sidebar", hidden: true, pageType: "note", sidebarSection: "Notes", ...next },
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await ctx.db.patch(sidebarPage._id, { sourceMeta: { ...metaOf(sidebarPage), ...next }, updatedAt: now });
  }
  return await readWorkspaceSettings(ctx.db);
}
