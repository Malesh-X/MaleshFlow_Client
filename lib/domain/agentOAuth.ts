// OAuth rules for agents that connect over MCP (Claude, ChatGPT, Claude Code).
// Pure and shared: Convex (convex/oauth.ts) enforces them, and the Next.js
// OAuth routes check them early. Uses only Web Crypto, so it runs in Convex,
// Node and the browser.

export const AGENT_ACCESS_TOKEN_PREFIX = "mfa_";
export const AGENT_REFRESH_TOKEN_PREFIX = "mfr_";
export const AGENT_CODE_PREFIX = "mfc_";

export const AUTHORIZATION_CODE_TTL_MS = 10 * 60_000;
export const ACCESS_TOKEN_TTL_MS = 60 * 60_000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60_000;

export const isAgentAccessToken = (value: string) => value.startsWith(AGENT_ACCESS_TOKEN_PREFIX);
// Any agent credential: never valid as an owner key.
export const isAgentCredential = (value: string) =>
  [AGENT_ACCESS_TOKEN_PREFIX, AGENT_REFRESH_TOKEN_PREFIX, AGENT_CODE_PREFIX].some((prefix) => value.startsWith(prefix));

// Redirect URIs an agent may register and receive codes at:
// - Claude (claude.ai, claude.com, the Claude apps): /api/mcp/auth_callback
// - ChatGPT connectors: the stable redirect, or the per-connector fallback
//   https://chatgpt.com/connector/oauth/{callback_id}
//   (developers.openai.com/apps-sdk/build/auth)
// - Loopback on any port and path, for Claude Code and other local clients
//   (RFC 8252). Plain http is allowed only for loopback.
const EXACT_REDIRECTS = new Set([
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
  "https://chatgpt.com/connector_platform_oauth_redirect",
]);
const CHATGPT_CALLBACK = /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1"]);

export function isAllowedRedirectUri(value: string) {
  if (value.length > 2048) return false;
  if (EXACT_REDIRECTS.has(value) || CHATGPT_CALLBACK.test(value)) return true;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) && !url.username && !url.password && !url.hash;
}

// The host shown on the sign-in page and in Connected Agents.
export function redirectHost(value: string) {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

export function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// 32 random bytes, base64url, after a prefix that says what it is.
export function randomToken(prefix: string) {
  return `${prefix}${base64Url(crypto.getRandomValues(new Uint8Array(32)))}`;
}

// RFC 7636: 43-128 characters from the unreserved set.
export const isValidCodeVerifier = (value: string) => /^[A-Za-z0-9\-._~]{43,128}$/.test(value);
export const isValidCodeChallenge = (value: string) => /^[A-Za-z0-9_-]{43}$/.test(value);

// PKCE S256: base64url(sha256(verifier)) must equal the challenge.
export async function verifyPkceS256(codeVerifier: string, codeChallenge: string) {
  if (!isValidCodeVerifier(codeVerifier) || !isValidCodeChallenge(codeChallenge)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier)));
  return base64Url(digest) === codeChallenge;
}

// A client name for display: one line, at most 80 characters.
export function cleanClientName(value: string | undefined | null) {
  const flat = (value ?? "").replace(/[\x00-\x1F\x7F]+/g, " ").replace(/\s+/g, " ").trim();
  return (flat || "Unnamed agent").slice(0, 80);
}
