// Dynamic client registration for MCP agents (RFC 7591).
import { preflight } from "@/lib/mcp/http";
import { convexOAuthBackend, handleRegister } from "@/lib/mcp/oauthRoutes";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleRegister(req, convexOAuthBackend());
export const OPTIONS = preflight;
