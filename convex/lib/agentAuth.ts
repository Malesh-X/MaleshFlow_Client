import type { DatabaseReader } from "../_generated/server";
import type { Id } from "../_generated/dataModel";
import { isAgentAccessToken, sha256Hex } from "../../lib/domain/agentOAuth";
import { AGENT_FUNCTIONS, type AgentFunctionName } from "./agentRegistry";
import { assertOwnerKeyGuarded, isAuthLocked } from "./authThrottle";

// Who is calling: the owner (the owner key) or an agent (an OAuth access
// token from convex/oauth.ts). Only functions in AGENT_FUNCTIONS call this;
// everything else uses assertOwnerKeyGuarded, which refuses agent tokens.
export type Caller =
  | { kind: "owner" }
  | { kind: "agent"; grantId: Id<"oauthGrants">; clientName: string };

export const isAgent = (caller: Caller) => caller.kind === "agent";

// The access token's row when it is valid now: not expired, not revoked, and
// its grant not revoked. Read-only, so queries can use it; revoking takes
// effect on the next call.
export async function findValidAccessToken(db: DatabaseReader, token: string) {
  if (!isAgentAccessToken(token)) return null;
  const tokenHash = await sha256Hex(token);
  const row = await db
    .query("oauthTokens")
    .withIndex("by_tokenHash", (query) => query.eq("tokenHash", tokenHash))
    .unique();
  if (!row || row.kind !== "access" || row.revokedAt !== null || row.expiresAt <= Date.now()) return null;
  const grant = await db.get(row.grantId);
  if (!grant || grant.revokedAt !== null) return null;
  return { row, grant };
}

export async function authorizeCaller(db: DatabaseReader, key: string, fn: AgentFunctionName): Promise<Caller> {
  if (isAgentAccessToken(key)) {
    if (!(fn in AGENT_FUNCTIONS)) throw new Error("This function doesn't accept agent tokens.");
    // A valid token works even while the owner-key lockout is on.
    const found = await findValidAccessToken(db, key);
    if (!found) {
      if (await isAuthLocked(db)) throw new Error("Too many failed access attempts. Try again later.");
      throw new Error("Invalid, expired or revoked agent token.");
    }
    return { kind: "agent", grantId: found.grant._id, clientName: found.grant.clientName };
  }
  await assertOwnerKeyGuarded(db, key);
  return { kind: "owner" };
}
