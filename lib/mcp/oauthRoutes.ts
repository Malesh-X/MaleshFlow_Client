// The OAuth endpoints for MCP agents (docs/mcp.md): dynamic client
// registration, the sign-in page (owner key, Allow / Deny) and the token
// endpoint. State lives in Convex (convex/oauth.ts); these handlers speak HTTP.
// The owner key only ever travels in the sign-in form's POST body.
import { anyApi } from "convex/server";
import { isAllowedRedirectUri, redirectHost } from "../domain/agentOAuth";
import { CORS_HEADERS, convexClient, json, originOf, resourceUrl, SCOPES } from "./http";

type OAuthFailure = { ok: false; error: string; description: string; lockedUntil?: number | null };
type Client = { clientId: string; clientName: string; redirectUris: string[] };

export type OAuthBackend = {
  registerClient: (args: { clientName?: string; redirectUris: string[] }) => Promise<({ ok: true } & Client & { createdAt: number }) | OAuthFailure>;
  getClient: (args: { clientId: string }) => Promise<Client | null>;
  approve: (args: {
    ownerKey: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    codeChallengeMethod: string;
    resource?: string;
  }) => Promise<{ ok: true; code: string } | OAuthFailure>;
  exchangeCode: (args: { clientId: string; code: string; codeVerifier: string; redirectUri: string; resource?: string }) => Promise<TokenResult>;
  refresh: (args: { clientId: string; refreshToken: string; resource?: string }) => Promise<TokenResult>;
};
type TokenResult = { ok: true; accessToken: string; refreshToken: string; expiresIn: number } | OAuthFailure;

export function convexOAuthBackend(): OAuthBackend {
  const client = convexClient();
  return {
    registerClient: (args) => client.mutation(anyApi.oauth.registerClient, args),
    getClient: (args) => client.query(anyApi.oauth.getClient, args),
    approve: (args) => client.mutation(anyApi.oauth.approve, args),
    exchangeCode: (args) => client.mutation(anyApi.oauth.exchangeCode, args),
    refresh: (args) => client.mutation(anyApi.oauth.refresh, args),
  };
}

const oauthJsonError = (error: string, description: string, status = 400) => json({ error, error_description: description }, status);

// ---- registration (RFC 7591) ----

export async function handleRegister(req: Request, backend: OAuthBackend) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return oauthJsonError("invalid_client_metadata", "Send client metadata as JSON.");
  }
  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris.filter((uri): uri is string => typeof uri === "string") : [];
  const grantTypes = Array.isArray(body.grant_types) ? body.grant_types : ["authorization_code", "refresh_token"];
  if (grantTypes.some((grant) => grant !== "authorization_code" && grant !== "refresh_token")) {
    return oauthJsonError("invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.");
  }
  const result = await backend.registerClient({
    clientName: typeof body.client_name === "string" ? body.client_name : undefined,
    redirectUris,
  });
  if (!result.ok) return oauthJsonError(result.error, result.description);
  return json(
    {
      client_id: result.clientId,
      client_id_issued_at: Math.floor(result.createdAt / 1000),
      client_name: result.clientName,
      redirect_uris: result.redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: SCOPES.join(" "),
    },
    201,
  );
}

// ---- token endpoint ----

async function formParams(req: Request) {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return new URLSearchParams(Object.entries(body).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  }
  return new URLSearchParams(await req.text());
}

// client_secret_basic carries the client id too (we issue no secrets).
function basicClientId(req: Request) {
  const match = (req.headers.get("authorization") ?? "").match(/^Basic\s+(\S+)$/i);
  if (!match) return null;
  try {
    return decodeURIComponent(atob(match[1]).split(":")[0] ?? "") || null;
  } catch {
    return null;
  }
}

export async function handleToken(req: Request, backend: OAuthBackend) {
  const params = await formParams(req);
  const clientId = params.get("client_id") ?? basicClientId(req);
  if (!clientId) return oauthJsonError("invalid_client", "client_id is required.", 401);
  const resource = params.get("resource") ?? undefined;
  if (resource !== undefined && resource !== resourceUrl(originOf(req))) {
    return oauthJsonError("invalid_target", `resource must be ${resourceUrl(originOf(req))}.`);
  }
  const grantType = params.get("grant_type");
  let result: TokenResult;
  if (grantType === "authorization_code") {
    const code = params.get("code");
    const codeVerifier = params.get("code_verifier");
    const redirectUri = params.get("redirect_uri");
    if (!code || !codeVerifier || !redirectUri) return oauthJsonError("invalid_request", "code, code_verifier and redirect_uri are required.");
    result = await backend.exchangeCode({ clientId, code, codeVerifier, redirectUri, ...(resource ? { resource } : {}) });
  } else if (grantType === "refresh_token") {
    const refreshToken = params.get("refresh_token");
    if (!refreshToken) return oauthJsonError("invalid_request", "refresh_token is required.");
    result = await backend.refresh({ clientId, refreshToken, ...(resource ? { resource } : {}) });
  } else {
    return oauthJsonError("unsupported_grant_type", "Use authorization_code or refresh_token.");
  }
  if (!result.ok) return oauthJsonError(result.error, result.description, result.error === "invalid_client" ? 401 : 400);
  return json(
    {
      access_token: result.accessToken,
      token_type: "Bearer",
      expires_in: result.expiresIn,
      refresh_token: result.refreshToken,
      scope: SCOPES.join(" "),
    },
    200,
    { Pragma: "no-cache" },
  );
}

// ---- sign-in page ----

const AUTHORIZE_FIELDS = ["response_type", "client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"] as const;
type AuthorizeParams = Partial<Record<(typeof AUTHORIZE_FIELDS)[number], string>>;

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

function pageHeaders(formTarget?: string) {
  const formAction = ["'self'", ...(formTarget ? [formTarget] : [])].join(" ");
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
  };
}

const STYLE = `
  :root { color-scheme: light dark; --bg: #f7f7f5; --card: #fff; --text: #1d1d1b; --muted: #6b6b66; --line: #deded9; --accent: #1d1d1b; --accent-text: #fff; --error: #b42318; }
  @media (prefers-color-scheme: dark) { :root { --bg: #161615; --card: #20201f; --text: #ededea; --muted: #9b9b95; --line: #34342f; --accent: #ededea; --accent-text: #161615; --error: #f97066; } }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text);
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { width: 100%; max-width: 420px; background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 28px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p { margin: 0 0 14px; color: var(--muted); }
  strong { color: var(--text); }
  label { display: block; font-weight: 600; margin: 18px 0 6px; }
  input[type=password] { width: 100%; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: var(--text); font: inherit; }
  .buttons { display: flex; flex-direction: row-reverse; gap: 10px; margin-top: 18px; }
  button { flex: 1; padding: 10px; border-radius: 8px; border: 1px solid var(--line); background: transparent; color: var(--text); font: inherit; font-weight: 600; cursor: pointer; }
  button.allow { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
  .error { color: var(--error); margin-top: 12px; }
  ul { margin: 0 0 14px; padding-left: 18px; color: var(--muted); }
`;

function htmlPage(title: string, body: string, status: number, formTarget?: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, { status, headers: pageHeaders(formTarget) });
}

const errorPage = (message: string, status = 400) =>
  htmlPage("Can't connect", `<h1>Can't connect this agent</h1><p>${escapeHtml(message)}</p>`, status);

function consentPage(params: AuthorizeParams, client: Client, error: string | null, status = 200) {
  const host = redirectHost(params.redirect_uri!);
  const hidden = AUTHORIZE_FIELDS.filter((name) => params[name] !== undefined)
    .map((name) => `<input type="hidden" name="${name}" value="${escapeHtml(params[name]!)}">`)
    .join("");
  const body = `
<h1>Connect ${escapeHtml(client.clientName)} to Flow?</h1>
<p><strong>${escapeHtml(client.clientName)}</strong> wants access to your MaleshFlow workspace. After you allow it, Flow sends it a key to <strong>${escapeHtml(host)}</strong>.</p>
<ul>
  <li>It can read pages and items, and add, edit, complete and move items.</li>
  <li>It can't see anything excluded from data dumps, change settings, or delete pages.</li>
  <li>It never sees your owner key. Revoke it any time with “Show Connected Agents”.</li>
</ul>
<!-- Allow is the first submit button, so Enter in the key field allows. -->
<form method="post" action="/oauth/authorize" autocomplete="off">
  ${hidden}
  <label for="owner_key">Owner key</label>
  <input id="owner_key" name="owner_key" type="password" autocomplete="off" autofocus>
  ${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ""}
  <div class="buttons">
    <button type="submit" name="decision" value="allow" class="allow">Allow</button>
    <button type="submit" name="decision" value="deny">Deny</button>
  </div>
</form>`;
  return htmlPage(`Connect ${client.clientName}`, body, status, new URL(params.redirect_uri!).origin);
}

function redirectWith(redirectUri: string, values: Record<string, string | undefined>) {
  const url = new URL(redirectUri);
  for (const [name, value] of Object.entries(values)) if (value !== undefined) url.searchParams.set(name, value);
  return new Response(null, { status: 303, headers: { Location: url.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}

// Checks the request. Problems with the client or redirect URI show an error
// page (never redirect to an unchecked address); other problems go back to
// the client as an OAuth error.
async function checkAuthorize(
  req: Request,
  params: AuthorizeParams,
  backend: OAuthBackend,
): Promise<{ response: Response; client?: never } | { client: Client; response?: never }> {
  if (!params.client_id || !params.redirect_uri) return { response: errorPage("The request is missing client_id or redirect_uri.") };
  const client = await backend.getClient({ clientId: params.client_id });
  if (!client) return { response: errorPage("This agent isn't registered with Flow. Remove the connector and add it again.") };
  if (!client.redirectUris.includes(params.redirect_uri) || !isAllowedRedirectUri(params.redirect_uri)) {
    return { response: errorPage("Flow only sends keys to Claude's and ChatGPT's callback addresses and to localhost, and only to an address the agent registered.") };
  }
  const back = (error: string, description: string) => ({
    response: redirectWith(params.redirect_uri!, { error, error_description: description, state: params.state, iss: originOf(req) }),
  });
  if (params.response_type !== "code") return back("unsupported_response_type", "Only response_type=code is supported.");
  if (!params.code_challenge || params.code_challenge_method !== "S256") return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  if (params.resource !== undefined && params.resource !== resourceUrl(originOf(req))) {
    return back("invalid_target", `resource must be ${resourceUrl(originOf(req))}.`);
  }
  return { client };
}

export async function handleAuthorizeGet(req: Request, backend: OAuthBackend) {
  const search = new URL(req.url).searchParams;
  const params: AuthorizeParams = Object.fromEntries(AUTHORIZE_FIELDS.flatMap((name) => (search.has(name) ? [[name, search.get(name)!]] : [])));
  const checked = await checkAuthorize(req, params, backend);
  if (checked.response) return checked.response;
  return consentPage(params, checked.client, null);
}

export async function handleAuthorizePost(req: Request, backend: OAuthBackend) {
  const form = new URLSearchParams(await req.text());
  const params: AuthorizeParams = Object.fromEntries(AUTHORIZE_FIELDS.flatMap((name) => (form.has(name) ? [[name, form.get(name)!]] : [])));
  const checked = await checkAuthorize(req, params, backend);
  if (checked.response) return checked.response;
  const iss = originOf(req);
  if (form.get("decision") !== "allow") {
    return redirectWith(params.redirect_uri!, { error: "access_denied", error_description: "The owner denied access.", state: params.state, iss });
  }
  const ownerKey = form.get("owner_key") ?? "";
  if (!ownerKey) return consentPage(params, checked.client, "Enter your owner key.", 400);
  const result = await backend.approve({
    ownerKey,
    clientId: params.client_id!,
    redirectUri: params.redirect_uri!,
    codeChallenge: params.code_challenge!,
    codeChallengeMethod: params.code_challenge_method!,
    ...(params.resource ? { resource: params.resource } : {}),
  });
  if (!result.ok) {
    if (result.error === "access_denied") {
      const message = result.lockedUntil
        ? `Too many wrong keys. Try again after ${new Date(result.lockedUntil).toUTCString()}.`
        : "That owner key isn't right.";
      return consentPage(params, checked.client, message, result.lockedUntil ? 429 : 401);
    }
    return redirectWith(params.redirect_uri!, { error: result.error, error_description: result.description, state: params.state, iss });
  }
  return redirectWith(params.redirect_uri!, { code: result.code, state: params.state, iss });
}

export const corsPreflight = () => new Response(null, { status: 204, headers: CORS_HEADERS });
