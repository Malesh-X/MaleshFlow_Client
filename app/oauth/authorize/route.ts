// Flow's sign-in page for MCP agents: shows who is asking, takes the owner
// key in a POST form, and redirects back with a code on Allow.
import { convexOAuthBackend, handleAuthorizeGet, handleAuthorizePost } from "@/lib/mcp/oauthRoutes";

export const dynamic = "force-dynamic";

export const GET = (req: Request) => handleAuthorizeGet(req, convexOAuthBackend());
export const POST = (req: Request) => handleAuthorizePost(req, convexOAuthBackend());
