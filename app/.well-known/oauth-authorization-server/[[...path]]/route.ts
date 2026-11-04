// RFC 8414 metadata for Flow's OAuth server (for MCP agents).
import { authorizationServerMetadata, json, originOf, preflight } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => json(authorizationServerMetadata(originOf(req)));
export const OPTIONS = preflight;
