import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { isAgentCredential, isAllowedRedirectUri, randomToken, redirectHost, verifyPkceS256 } from "../lib/domain/agentOAuth";

test("redirect allowlist: Claude, ChatGPT and loopback only", () => {
  for (const uri of [
    "https://claude.ai/api/mcp/auth_callback",
    "https://claude.com/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "https://chatgpt.com/connector/oauth/abc_123-XYZ",
    "http://localhost:53712/callback",
    "http://127.0.0.1:8080/oauth/callback",
    "http://localhost/callback",
  ]) assert.ok(isAllowedRedirectUri(uri), uri);
  for (const uri of [
    "https://claude.ai/api/mcp/auth_callback/",
    "https://claude.ai/api/mcp/auth_callback?x=1",
    "http://claude.ai/api/mcp/auth_callback",
    "https://evil.claude.ai/api/mcp/auth_callback",
    "https://chatgpt.com/connector/oauth/../evil",
    "https://localhost:3000/callback",
    "http://localhost.evil.com/callback",
    "http://user@localhost:3000/cb",
    "http://10.0.0.1:3000/cb",
    "http://[::1]:3000/cb",
    "javascript:alert(1)",
    "not a url",
  ]) assert.ok(!isAllowedRedirectUri(uri), uri);
  assert.equal(redirectHost("http://localhost:53712/callback"), "localhost:53712");
});

test("PKCE S256 matches RFC 7636's example and refuses anything else", async () => {
  // RFC 7636 appendix B.
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  assert.equal(await verifyPkceS256(verifier, challenge), true);
  assert.equal(await verifyPkceS256(verifier.slice(0, -1) + "l", challenge), false);
  assert.equal(await verifyPkceS256("short", challenge), false);
  assert.equal(await verifyPkceS256(verifier, verifier), false);
  const mine = "x".repeat(64);
  assert.equal(await verifyPkceS256(mine, createHash("sha256").update(mine).digest("base64url")), true);
});

test("agent credentials are prefixed, random and never an owner key", () => {
  const a = randomToken("mfa_");
  assert.match(a, /^mfa_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, randomToken("mfa_"));
  assert.ok(isAgentCredential(a) && isAgentCredential("mfr_x") && isAgentCredential("mfc_x"));
  assert.ok(!isAgentCredential("an-owner-key"));
});
