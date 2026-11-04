// HTTP pieces of the Flow MCP server and its OAuth endpoints (docs/mcp.md):
// discovery metadata, CORS, the per-request handler for /api/mcp, and the
// Convex calls made with an agent's token. Route files in app/ stay thin.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { ConvexError } from "convex/values";
import { ToolError, registerFlowTools, type FlowCalls } from "./tools";

export const MCP_PATH = "/api/mcp";
export const SCOPES = ["flow"];

// The origin clients reached us at (https://flow.malesh.com in production).
export const originOf = (req: Request) => new URL(req.url).origin;
export const resourceUrl = (origin: string) => `${origin}${MCP_PATH}`;
export const protectedResourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource${MCP_PATH}`;

// RFC 9728.
export function protectedResourceMetadata(origin: string) {
  return {
    resource: resourceUrl(origin),
    authorization_servers: [origin],
    scopes_supported: SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "MaleshFlow",
  };
}

// RFC 8414.
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    scopes_supported: SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    authorization_response_iss_parameter_supported: true,
  };
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store", ...headers } });

export const preflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });

// ---- Convex ----

export function convexClient() {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set.");
  return new ConvexHttpClient(url);
}

const fn = (path: string) => {
  const [mod, name] = path.split(":");
  return anyApi[mod][name];
};

// Convex calls made with the agent's access token in place of the owner key.
export function agentCalls(client: ConvexHttpClient, token: string): FlowCalls {
  return {
    query: (path, args = {}) => client.query(fn(path), { ...args, ownerKey: token }),
    mutation: (path, args = {}) => client.mutation(fn(path), { ...args, ownerKey: token }),
  };
}

// A message the agent can read. ConvexErrors carry one in `data`; other
// server errors read "Server Error" in production. Never echoes a token.
export function errorText(error: unknown, token?: string) {
  let message = error instanceof Error ? error.message : String(error);
  if (error instanceof ConvexError) {
    const data = error.data as unknown;
    if (typeof data === "string") message = data;
    else if (data && typeof data === "object" && typeof (data as { message?: unknown }).message === "string") message = (data as { message: string }).message;
  } else if (!(error instanceof ToolError)) {
    message = message.replace(/^\[CONVEX [^\]]*\]\s*(\[Request ID: [^\]]*\]\s*)?/, "").replace(/^Server Error\s*/, "Server error. ") || "Server error.";
    // Convex validation errors echo the arguments; drop them.
    message = message.split(/\n\s*(Object|Path|Value):/)[0];
  }
  if (token) message = message.split(token).join("<token>");
  return message.trim();
}

// ---- /api/mcp ----

export type McpDeps = {
  // True when the bearer token is a valid, unrevoked access token for this resource.
  authenticate: (token: string, resource: string) => Promise<boolean>;
  calls: (token: string) => FlowCalls;
};

function unauthorized(origin: string, error?: "invalid_token") {
  const params = [`resource_metadata="${protectedResourceMetadataUrl(origin)}"`, `scope="${SCOPES.join(" ")}"`];
  if (error) params.unshift(`error="${error}"`, 'error_description="The access token is invalid, expired or revoked."');
  return json(
    { error: error ?? "unauthorized", error_description: "Connect Flow through OAuth; see /.well-known/oauth-protected-resource." },
    401,
    { "WWW-Authenticate": `Bearer ${params.join(", ")}` },
  );
}

export function bearerToken(req: Request) {
  const header = req.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1] : null;
}

// Stateless Streamable HTTP: a fresh server and transport per request, with
// JSON responses (no SSE stream to keep open).
export async function handleMcpRequest(req: Request, deps: McpDeps) {
  const origin = originOf(req);
  const token = bearerToken(req);
  if (!token) return unauthorized(origin);
  if (!(await deps.authenticate(token, resourceUrl(origin)))) return unauthorized(origin, "invalid_token");

  const server = new McpServer(
    { name: "maleshflow", title: "MaleshFlow", version: "1.0.0" },
    {
      instructions:
        "MaleshFlow is an outliner of pages with nested notes and tasks. Find pages with list_pages or search, read them with read_page, " +
        "and change items by the ids shown in parentheses. Items and pages excluded from data dumps are hidden from you, and writes that touch them are refused.",
    },
  );
  registerFlowTools(server, deps.calls(token), (error) => errorText(error, token));
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(req, { authInfo: { token, clientId: "agent", scopes: SCOPES } });
    const headers = new Headers(response.headers);
    for (const [name, value] of Object.entries(CORS_HEADERS)) headers.set(name, value);
    return new Response(response.body, { status: response.status, headers });
  } finally {
    // JSON responses are complete once handleRequest returns.
    void server.close();
  }
}

// The deps used in production: Convex over HTTP.
export function convexMcpDeps(): McpDeps {
  const client = convexClient();
  return {
    authenticate: async (token, resource) => {
      try {
        const result = (await client.mutation(anyApi.oauth.authenticate, { accessToken: token, resource })) as { ok: boolean };
        return result.ok;
      } catch {
        return false;
      }
    },
    calls: (token) => agentCalls(convexClient(), token),
  };
}
