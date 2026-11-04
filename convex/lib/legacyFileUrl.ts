import type { Id } from "../_generated/dataModel";

// The authenticated download path for a legacy file (convex/http.ts). It
// only works with the owner key in an Authorization header.
export function legacyFileDownloadUrl(fileId: Id<"legacyFiles">) {
  const siteUrl = process.env.CONVEX_SITE_URL;
  return siteUrl ? `${siteUrl}/legacy-file?id=${encodeURIComponent(fileId)}` : null;
}
