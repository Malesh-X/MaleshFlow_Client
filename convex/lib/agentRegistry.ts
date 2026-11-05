// The only public Convex functions that accept an agent access token (the
// OAuth token an MCP client like Claude or ChatGPT holds; see convex/oauth.ts).
// Every other public function takes only the owner key: assertOwnerKey
// refuses agent tokens.
//
// tests/guardCoverage.test.ts checks that each function here calls
// authorizeCaller with its own name and applies the data dump hiding rule
// (convex/lib/agentVisibility.ts), unless it is listed with `noContent`
// because it returns nothing from pages or items. No function that changes
// exclusions, settings, auth or tokens, or deletes pages, belongs here.

export type AgentEntry = { hiding: string; noContent?: true };

export const AGENT_FUNCTIONS = {
  "workspace:listPages": { hiding: "leaves out excluded pages" },
  "workspace:getPageTree": { hiding: "null for an excluded page; leaves out excluded items with their subtrees; no backlinks" },
  "workspace:getNodeDetail": { hiding: "null for a hidden item; leaves out hidden ancestors' text and excluded children" },
  "workspace:searchLinkTargets": { hiding: "leaves out excluded pages and hidden items" },
  "workspace:resolveLinkTargets": { hiding: "hidden targets come back without text (for everyone)" },
  "workspace:getWorkspaceSettings": { hiding: "time zone and completion mode only", noContent: true },
  "workspace:createNodesBatch": { hiding: "refuses an excluded page, hidden parents and anchors, and items that would land hidden" },
  "workspace:updateNode": { hiding: "refuses a hidden item" },
  "workspace:setRecurrenceBasis": { hiding: "refuses a hidden item" },
  "workspace:setNodeCompletion": { hiding: "refuses a hidden item or an excluded planner page" },
  "workspace:undoCompletion": { hiding: "refuses a receipt that touches a hidden item" },
  "workspace:moveNodeTree": { hiding: "refuses hidden items, an excluded destination, and moves that would land hidden" },
  "guardViolations:reportRefusal": { hiding: "logs a refused write; reads and returns nothing", noContent: true },
} satisfies Record<string, AgentEntry>;

export type AgentFunctionName = keyof typeof AGENT_FUNCTIONS;

// Helpers that apply the hiding rule (convex/lib/agentVisibility.ts).
export const AGENT_HIDING_FUNCTION_NAMES = [
  "agentVisiblePages",
  "agentVisibleTree",
  "agentRefusePage",
  "agentRefuseNodes",
  "agentRefuseLanding",
  "agentRefuseReceipts",
  "createHiddenChecker",
];
