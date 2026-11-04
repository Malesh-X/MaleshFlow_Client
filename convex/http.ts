import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { buildTaskCalendarIcs, type TaskCalendarFeed } from "../lib/domain/calendar";
import { assertOwnerKeyGuardedInAction } from "./lib/authThrottle";

const http = httpRouter();

http.route({
  path: "/task-calendar.ics",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const url = new URL(req.url);
    const token = url.searchParams.get("token")?.trim() ?? "";
    if (token.length === 0) {
      return new Response("Missing task calendar token.", {
        status: 400,
      });
    }

    const feed: TaskCalendarFeed | null = await ctx.runQuery(
      internal.calendar.getTaskCalendarFeedByToken,
      { token },
    );
    if (!feed) {
      return new Response("Task calendar feed not found.", {
        status: 404,
      });
    }

    return new Response(buildTaskCalendarIcs(feed), {
      status: 200,
      headers: {
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": 'inline; filename="maleshflow-tasks.ics"',
        "Cache-Control": "no-store",
      },
    });
  }),
});

// Legacy file downloads, owner only. The app fetches with
// "Authorization: Bearer <owner key>" and shows the result through a blob URL,
// so no storage URL that works without the key is ever handed out. A wrong
// key counts toward the lockout. CORS allows any origin: there are no
// cookies, so a page without the key gets nothing.
const LEGACY_FILE_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization",
  "Access-Control-Max-Age": "86400",
};

http.route({
  path: "/legacy-file",
  method: "OPTIONS",
  handler: httpAction(async () => new Response(null, { status: 204, headers: LEGACY_FILE_CORS })),
});

http.route({
  path: "/legacy-file",
  method: "GET",
  handler: httpAction(async (ctx, req) => {
    const header = req.headers.get("Authorization") ?? "";
    const ownerKey = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    try {
      await assertOwnerKeyGuardedInAction(ctx, ownerKey);
    } catch (error) {
      return new Response(error instanceof Error ? error.message : "Unauthorized.", {
        status: 401,
        headers: LEGACY_FILE_CORS,
      });
    }
    const fileId = new URL(req.url).searchParams.get("id") ?? "";
    const file = await ctx.runQuery(internal.legacy.getLegacyFileForDownload, { fileId });
    const blob = file ? await ctx.storage.get(file.storageId) : null;
    if (!file || !blob) {
      return new Response("File not found.", { status: 404, headers: LEGACY_FILE_CORS });
    }
    return new Response(blob, {
      status: 200,
      headers: {
        ...LEGACY_FILE_CORS,
        "Content-Type": file.mimeType || "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(file.fileName)}`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  }),
});

export default http;
