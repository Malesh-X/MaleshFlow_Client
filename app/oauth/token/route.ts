// OAuth token endpoint for MCP agents (authorization_code, refresh_token).
import { preflight } from "@/lib/mcp/http";
import { convexOAuthBackend, handleToken } from "@/lib/mcp/oauthRoutes";

export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleToken(req, convexOAuthBackend());
export const OPTIONS = preflight;
