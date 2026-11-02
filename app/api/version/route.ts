// Returns the identity of the frontend that is deployed now. Open tabs compare
// it with the build they loaded to find out they are running an old bundle.
export const dynamic = "force-dynamic";

export function GET() {
  return Response.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? null },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
