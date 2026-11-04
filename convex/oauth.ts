// OAuth 2.1 for agents connecting over MCP (docs/mcp.md). The Next.js routes
// under app/oauth and app/.well-known speak HTTP; these functions hold the
// state. Codes and tokens are random values returned once and stored only as
// SHA-256 hashes, with the client name, created, last-used and revoked times.
//
// - registerClient: dynamic client registration (redirect URIs allowlisted).
// - approve: the sign-in page's Allow. Checks the owner key with the same
//   lockout as the app (recordOwnerKeyValidation) and issues a single-use,
//   10-minute authorization code bound to the client, redirect URI and PKCE
//   S256 challenge.
// - exchangeCode / refresh: the token endpoint. Access tokens last an hour;
//   refresh tokens rotate, and presenting a used one revokes the whole grant.
// - authenticate: the MCP endpoint's per-request check (records last use).
// - listConnectedAgents / revokeConnectedAgent: owner-only, for the
//   "Show Connected Agents" action.
//
// Mutations that can fail after writing (a wrong owner key counts toward the
// lockout, a reused code revokes its tokens) return errors as values instead
// of throwing, since a throw would roll the write back.
import { v } from "convex/values";
import { mutation, query, type DatabaseReader, type MutationCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import {
  ACCESS_TOKEN_TTL_MS,
  AGENT_ACCESS_TOKEN_PREFIX,
  AGENT_CODE_PREFIX,
  AGENT_REFRESH_TOKEN_PREFIX,
  AUTHORIZATION_CODE_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  cleanClientName,
  isAllowedRedirectUri,
  isValidCodeChallenge,
  randomToken,
  redirectHost,
  sha256Hex,
  verifyPkceS256,
} from "../lib/domain/agentOAuth";
import { assertOwnerKeyGuarded, recordOwnerKeyValidation } from "./lib/authThrottle";
import { findValidAccessToken } from "./lib/agentAuth";
import { withGuards } from "./lib/guards";

const MAX_REDIRECT_URIS = 10;
const MAX_CLIENTS = 500;
const LAST_USED_RESOLUTION_MS = 60_000;

type OAuthError = { ok: false; error: string; description: string };
const oauthError = (error: string, description: string): OAuthError => ({ ok: false, error, description });

async function findClient(ctx: { db: DatabaseReader }, clientId: string) {
  return await ctx.db
    .query("oauthClients")
    .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
    .unique();
}

export const registerClient = mutation({
  args: {
    clientName: v.optional(v.string()),
    redirectUris: v.array(v.string()),
  },
  handler: async (rawCtx, args) => {
    const ctx = withGuards(rawCtx, "oauth:registerClient");
    const redirectUris = [...new Set(args.redirectUris)];
    if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
      return oauthError("invalid_redirect_uri", `Register between 1 and ${MAX_REDIRECT_URIS} redirect URIs.`);
    }
    const refused = redirectUris.find((uri) => !isAllowedRedirectUri(uri));
    if (refused) {
      return oauthError(
        "invalid_redirect_uri",
        "Flow only issues keys to Claude's and ChatGPT's callback addresses and to http://localhost or http://127.0.0.1.",
      );
    }
    const existing = await ctx.db.query("oauthClients").take(MAX_CLIENTS);
    if (existing.length >= MAX_CLIENTS) {
      // Drop the oldest registration that never got a grant.
      const grants = await ctx.db.query("oauthGrants").take(1000);
      const used = new Set(grants.map((grant) => grant.clientId));
      const stale = existing.find((client) => !used.has(client.clientId));
      if (!stale) return oauthError("temporarily_unavailable", "Too many registered clients.");
      await ctx.db.delete(stale._id);
    }
    const clientId = randomToken("mfclient_");
    const clientName = cleanClientName(args.clientName);
    const now = Date.now();
    await ctx.db.insert("oauthClients", { clientId, clientName, redirectUris, createdAt: now });
    return { ok: true as const, clientId, clientName, redirectUris, createdAt: now };
  },
});

// What the sign-in page shows. Null for an unknown client.
export const getClient = query({
  args: { clientId: v.string() },
  handler: async (ctx, args) => {
    const client = await findClient(ctx, args.clientId);
    return client ? { clientId: client.clientId, clientName: client.clientName, redirectUris: client.redirectUris } : null;
  },
});

export const approve = mutation({
  args: {
    ownerKey: v.string(),
    clientId: v.string(),
    redirectUri: v.string(),
    codeChallenge: v.string(),
    codeChallengeMethod: v.string(),
    resource: v.optional(v.string()),
  },
  handler: async (rawCtx, args) => {
    const ctx = withGuards(rawCtx, "oauth:approve");
    const client = await findClient(ctx, args.clientId);
    if (!client) return oauthError("invalid_client", "Unknown client.");
    if (!client.redirectUris.includes(args.redirectUri) || !isAllowedRedirectUri(args.redirectUri)) {
      return oauthError("invalid_request", "That redirect URI isn't registered for this client.");
    }
    if (args.codeChallengeMethod !== "S256" || !isValidCodeChallenge(args.codeChallenge)) {
      return oauthError("invalid_request", "PKCE with code_challenge_method S256 is required.");
    }
    // Counts a wrong key toward the lockout (and refuses while locked).
    const check = await recordOwnerKeyValidation(ctx.db, args.ownerKey);
    if (!check.valid) {
      return check.lockedUntil
        ? { ...oauthError("access_denied", "Too many failed attempts. Try again later."), lockedUntil: check.lockedUntil }
        : { ...oauthError("access_denied", "That owner key isn't right."), lockedUntil: null };
    }
    const now = Date.now();
    const grantId = await ctx.db.insert("oauthGrants", {
      clientId: client.clientId,
      clientName: client.clientName,
      redirectHost: redirectHost(args.redirectUri),
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    });
    const code = randomToken(AGENT_CODE_PREFIX);
    await ctx.db.insert("oauthCodes", {
      codeHash: await sha256Hex(code),
      grantId,
      clientId: client.clientId,
      clientName: client.clientName,
      redirectUri: args.redirectUri,
      codeChallenge: args.codeChallenge,
      resource: args.resource ?? null,
      expiresAt: now + AUTHORIZATION_CODE_TTL_MS,
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    });
    return { ok: true as const, code };
  },
});

async function issueTokens(ctx: MutationCtx, grant: Doc<"oauthGrants">, resource: string | null) {
  const now = Date.now();
  const accessToken = randomToken(AGENT_ACCESS_TOKEN_PREFIX);
  const refreshToken = randomToken(AGENT_REFRESH_TOKEN_PREFIX);
  const base = { grantId: grant._id, clientId: grant.clientId, clientName: grant.clientName, resource, createdAt: now, lastUsedAt: null, revokedAt: null };
  await ctx.db.insert("oauthTokens", { ...base, kind: "access", tokenHash: await sha256Hex(accessToken), expiresAt: now + ACCESS_TOKEN_TTL_MS });
  await ctx.db.insert("oauthTokens", { ...base, kind: "refresh", tokenHash: await sha256Hex(refreshToken), expiresAt: now + REFRESH_TOKEN_TTL_MS });
  return {
    ok: true as const,
    accessToken,
    refreshToken,
    expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
  };
}

// Revokes a grant and every token issued under it. Expired rows are deleted.
async function revokeGrant(ctx: MutationCtx, grantId: Id<"oauthGrants">) {
  const now = Date.now();
  const grant = await ctx.db.get(grantId);
  if (grant && grant.revokedAt === null) await ctx.db.patch(grant._id, { revokedAt: now });
  for (const token of await ctx.db.query("oauthTokens").withIndex("by_grantId", (q) => q.eq("grantId", grantId)).take(500)) {
    if (token.expiresAt <= now) await ctx.db.delete(token._id);
    else if (token.revokedAt === null) await ctx.db.patch(token._id, { revokedAt: now });
  }
}

// The resource (RFC 8707) a token request names must match the one approved.
const resourceMatches = (approved: string | null, requested: string | undefined) =>
  requested === undefined || approved === null || approved === requested;

export const exchangeCode = mutation({
  args: {
    clientId: v.string(),
    code: v.string(),
    codeVerifier: v.string(),
    redirectUri: v.string(),
    resource: v.optional(v.string()),
  },
  handler: async (rawCtx, args) => {
    const ctx = withGuards(rawCtx, "oauth:exchangeCode");
    const codeHash = await sha256Hex(args.code);
    const row = await ctx.db
      .query("oauthCodes")
      .withIndex("by_codeHash", (q) => q.eq("codeHash", codeHash))
      .unique();
    const now = Date.now();
    if (!row || row.clientId !== args.clientId) return oauthError("invalid_grant", "Unknown authorization code.");
    if (row.lastUsedAt !== null || row.revokedAt !== null) {
      // A second use: revoke whatever the first use issued (RFC 6749 4.1.2).
      await ctx.db.patch(row._id, { revokedAt: row.revokedAt ?? now });
      await revokeGrant(ctx, row.grantId);
      return oauthError("invalid_grant", "That authorization code was already used.");
    }
    // Single use from here on, whatever the outcome.
    await ctx.db.patch(row._id, { lastUsedAt: now });
    if (row.expiresAt <= now) return oauthError("invalid_grant", "That authorization code expired.");
    if (row.redirectUri !== args.redirectUri) return oauthError("invalid_grant", "redirect_uri doesn't match the authorization request.");
    if (!(await verifyPkceS256(args.codeVerifier, row.codeChallenge))) return oauthError("invalid_grant", "PKCE verification failed.");
    if (!resourceMatches(row.resource, args.resource)) return oauthError("invalid_target", "resource doesn't match the authorization request.");
    const grant = await ctx.db.get(row.grantId);
    if (!grant || grant.revokedAt !== null) return oauthError("invalid_grant", "This connection was revoked.");
    await ctx.db.patch(grant._id, { lastUsedAt: now });
    return await issueTokens(ctx, grant, row.resource ?? args.resource ?? null);
  },
});

export const refresh = mutation({
  args: {
    clientId: v.string(),
    refreshToken: v.string(),
    resource: v.optional(v.string()),
  },
  handler: async (rawCtx, args) => {
    const ctx = withGuards(rawCtx, "oauth:refresh");
    const tokenHash = await sha256Hex(args.refreshToken);
    const row = await ctx.db
      .query("oauthTokens")
      .withIndex("by_tokenHash", (q) => q.eq("tokenHash", tokenHash))
      .unique();
    const now = Date.now();
    if (!row || row.kind !== "refresh" || row.clientId !== args.clientId) return oauthError("invalid_grant", "Unknown refresh token.");
    if (row.lastUsedAt !== null) {
      // Rotated already: someone replayed an old token. Revoke the grant.
      await revokeGrant(ctx, row.grantId);
      return oauthError("invalid_grant", "That refresh token was already used; the connection was revoked.");
    }
    if (row.revokedAt !== null) return oauthError("invalid_grant", "That refresh token was revoked.");
    if (row.expiresAt <= now) return oauthError("invalid_grant", "That refresh token expired.");
    if (!resourceMatches(row.resource, args.resource)) return oauthError("invalid_target", "resource doesn't match the original grant.");
    const grant = await ctx.db.get(row.grantId);
    if (!grant || grant.revokedAt !== null) return oauthError("invalid_grant", "This connection was revoked.");
    await ctx.db.patch(row._id, { lastUsedAt: now });
    await ctx.db.patch(grant._id, { lastUsedAt: now });
    // Tidy up this grant's expired and used tokens.
    for (const token of await ctx.db.query("oauthTokens").withIndex("by_grantId", (q) => q.eq("grantId", grant._id)).take(200)) {
      if (token._id !== row._id && (token.expiresAt <= now || (token.kind === "refresh" && token.lastUsedAt !== null))) {
        await ctx.db.delete(token._id);
      }
    }
    return await issueTokens(ctx, grant, row.resource);
  },
});

// The MCP endpoint's check on each request: valid, unexpired, unrevoked, and
// for this resource. Records the last use (at most once a minute).
export const authenticate = mutation({
  args: {
    accessToken: v.string(),
    resource: v.optional(v.string()),
  },
  handler: async (rawCtx, args) => {
    const ctx = withGuards(rawCtx, "oauth:authenticate");
    const found = await findValidAccessToken(ctx.db, args.accessToken);
    if (!found) return { ok: false as const };
    if (!resourceMatches(found.row.resource, args.resource)) return { ok: false as const };
    const now = Date.now();
    if (found.grant.lastUsedAt === null || now - found.grant.lastUsedAt > LAST_USED_RESOLUTION_MS) {
      await ctx.db.patch(found.grant._id, { lastUsedAt: now });
    }
    if (found.row.lastUsedAt === null || now - found.row.lastUsedAt > LAST_USED_RESOLUTION_MS) {
      await ctx.db.patch(found.row._id, { lastUsedAt: now });
    }
    return { ok: true as const, clientName: found.grant.clientName, expiresAt: found.row.expiresAt };
  },
});

// Owner only: connections that aren't revoked, newest first.
export const listConnectedAgents = query({
  args: { ownerKey: v.string() },
  handler: async (ctx, args) => {
    await assertOwnerKeyGuarded(ctx.db, args.ownerKey);
    const grants = await ctx.db
      .query("oauthGrants")
      .withIndex("by_revokedAt", (q) => q.eq("revokedAt", null))
      .order("desc")
      .take(200);
    return grants.map((grant) => ({
      grantId: grant._id,
      clientName: grant.clientName,
      redirectHost: grant.redirectHost,
      createdAt: grant.createdAt,
      lastUsedAt: grant.lastUsedAt,
    }));
  },
});

// Owner only. Takes effect on the agent's next request.
export const revokeConnectedAgent = mutation({
  args: { ownerKey: v.string(), grantId: v.id("oauthGrants") },
  handler: async (rawCtx, args) => {
    const ctx = withGuards(rawCtx, "oauth:revokeConnectedAgent");
    await assertOwnerKeyGuarded(ctx.db, args.ownerKey);
    await revokeGrant(ctx, args.grantId);
    return null;
  },
});
