// Legacy files are served by the authenticated HTTP action in convex/http.ts
// (GET /legacy-file?id=…), never by a raw storage URL. Fetch with the owner
// key in the Authorization header.
export async function fetchLegacyFile(downloadUrl: string, ownerKey: string): Promise<Blob> {
  const response = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${ownerKey}` } });
  if (!response.ok) {
    throw new Error((await response.text().catch(() => "")) || `Download failed (${response.status}).`);
  }
  return await response.blob();
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
