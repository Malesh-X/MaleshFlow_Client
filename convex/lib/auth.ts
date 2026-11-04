import { isAgentCredential } from "../../lib/domain/agentOAuth";

export function isOwnerKeyConfigured() {
  return Boolean(process.env.OWNER_ACCESS_TOKEN);
}

// Fails closed: a missing OWNER_ACCESS_TOKEN rejects everything rather than
// silently opening the workspace to anyone with the deployment URL.
export function isOwnerKeyValid(ownerKey: string) {
  const configuredOwnerKey = process.env.OWNER_ACCESS_TOKEN;

  if (!configuredOwnerKey) {
    return false;
  }

  return !isAgentCredential(ownerKey) && constantTimeEqual(ownerKey, configuredOwnerKey);
}

// Compares every character, so the time taken doesn't reveal how much of a
// guess was right. (Length can still leak; the key is long and random.)
export function constantTimeEqual(a: string, b: string) {
  let diff = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    diff |= (index < a.length ? a.charCodeAt(index) : 0) ^ (index < b.length ? b.charCodeAt(index) : 0);
  }
  return diff === 0;
}

export function assertOwnerKey(ownerKey: string) {
  // Agent tokens only work with the functions in convex/lib/agentRegistry.ts,
  // which check them with authorizeCaller instead.
  if (isAgentCredential(ownerKey)) {
    throw new Error("Agent tokens can't call this function.");
  }
  if (!isOwnerKeyConfigured()) {
    throw new Error(
      "OWNER_ACCESS_TOKEN is not configured on this deployment; access is disabled until it is set.",
    );
  }
  if (!isOwnerKeyValid(ownerKey)) {
    throw new Error("Invalid owner access token.");
  }
}
