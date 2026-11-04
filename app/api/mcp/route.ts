// The Flow MCP server (Streamable HTTP, stateless). See docs/mcp.md.
import { convexMcpDeps, handleMcpRequest, preflight } from "@/lib/mcp/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const handle = (req: Request) => handleMcpRequest(req, convexMcpDeps());
export { handle as GET, handle as POST, handle as DELETE };
export const OPTIONS = preflight;
