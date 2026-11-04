// RFC 9728 metadata for the MCP endpoint, at the root and at the
// path-suffixed form (/.well-known/oauth-protected-resource/api/mcp).
import { json, originOf, preflight, protectedResourceMetadata } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => json(protectedResourceMetadata(originOf(req)));
export const OPTIONS = preflight;
