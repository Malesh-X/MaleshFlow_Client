// Retired public functions, kept as harmless stubs for open tabs.
//
// A deploy updates the Convex backend before Vercel promotes the new
// frontend, and tabs opened earlier keep running their old bundle until they
// reload. A public function those bundles still call must keep answering
// for a while after the app stops using it, or those tabs break.
//
// The rule (docs/deploying.md): remove the client usage first, keep a stub
// here for at least a week, then delete it. Each stub is registered under its
// old name in its old module (Convex names a function by module:export), in
// one line pointing back here. tests/publicFunctions.test.ts fails when a
// public function disappears without passing through this list.
//
// To delete a stub after its date: remove its registration line, its entry
// below and its line in tests/publicFunctions.snapshot.json.

import { v } from "convex/values";

export type RetiredFunction = {
  // The commit that removed the real function.
  retiredIn: string;
  // Delete the stub on or after this date.
  deleteAfter: string;
  // What the stub returns, and why that is safe for an old tab.
  behavior: string;
};

export const RETIRED_PUBLIC_FUNCTIONS = {
  "workspace:validateOwnerKey": {
    retiredIn: "24dfbdb",
    deleteAfter: "2026-11-11",
    behavior:
      "Always null, whatever the key: reveals nothing about it, so it is no guessing path. " +
      "Old tabs read null as 'still checking': they keep the saved key (only false cleared it), " +
      "load no data and reload to the new build.",
  },
  "chatData:getWorkspaceKnowledgeThread": {
    retiredIn: "5938c9e",
    deleteAfter: "2026-11-11",
    behavior: "Always null (no thread). Old tabs subscribed to it on load.",
  },
  "workspace:getWorkspaceAiMemory": {
    retiredIn: "5938c9e",
    deleteAfter: "2026-11-11",
    behavior: "Always null; old tabs fall back to their default text. Subscribed on load.",
  },
  "workspace:getWorkspaceInbox": {
    retiredIn: "5938c9e",
    deleteAfter: "2026-11-11",
    behavior: "Always null; old tabs show an empty Inbox. Subscribed on load.",
  },
  "workspace:getWorkspaceRandomBox": {
    retiredIn: "5938c9e",
    deleteAfter: "2026-11-11",
    behavior: "Always null; old tabs show an empty Random Box. Subscribed on load.",
  },
} satisfies Record<string, RetiredFunction>;

export type RetiredFunctionName = keyof typeof RETIRED_PUBLIC_FUNCTIONS;

// Definitions for query(...) in the old module. They read nothing and ignore
// the key, so they need no owner-key check: the answer is the same for
// everyone.
export const retiredNullQuery = {
  args: { ownerKey: v.string() },
  returns: v.null(),
  handler: async () => null,
};
