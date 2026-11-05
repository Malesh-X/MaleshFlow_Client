// A write the server guards refused (convex/lib/guards.ts, enforce mode).
//
// The refused mutation rolls back, including any log row it wrote, so the
// caller reports the refusal with guardViolations:reportRefusal. The app,
// the CLI and the MCP server all do; their error text reads `data.message`.

export const GUARD_REFUSED_CODE = "guardRefused";

export const GUARD_REFUSAL_CALLERS = ["app", "cli", "mcp"] as const;
export type GuardRefusalCaller = (typeof GUARD_REFUSAL_CALLERS)[number];

export type GuardRefusal = {
  code: typeof GUARD_REFUSED_CODE;
  mutation: string;
  guard: string;
  message: string;
  detail: string;
  nodeId: string | null;
  pageId: string | null;
};

// The refusal carried by an error, or null. Reads `data` the way ConvexError
// does, without importing it, so plain objects in tests work too.
export function guardRefusalOf(error: unknown): GuardRefusal | null {
  if (!error || typeof error !== "object") return null;
  const data = (error as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  if (value.code !== GUARD_REFUSED_CODE) return null;
  if (typeof value.mutation !== "string" || typeof value.guard !== "string" || typeof value.message !== "string") return null;
  return {
    code: GUARD_REFUSED_CODE,
    mutation: value.mutation,
    guard: value.guard,
    message: value.message,
    detail: typeof value.detail === "string" ? value.detail : value.message,
    nodeId: typeof value.nodeId === "string" ? value.nodeId : null,
    pageId: typeof value.pageId === "string" ? value.pageId : null,
  };
}

// The arguments for guardViolations:reportRefusal (plus the caller's key).
export function refusalReportArgs(refusal: GuardRefusal, caller: GuardRefusalCaller) {
  return {
    caller,
    mutation: refusal.mutation,
    guard: refusal.guard,
    detail: refusal.detail,
    ...(refusal.nodeId ? { nodeId: refusal.nodeId } : {}),
    ...(refusal.pageId ? { pageId: refusal.pageId } : {}),
  };
}

// Reports a refusal and never throws: logging must not hide the original error.
export async function reportGuardRefusal(
  error: unknown,
  caller: GuardRefusalCaller,
  send: (args: ReturnType<typeof refusalReportArgs>) => Promise<unknown>,
) {
  const refusal = guardRefusalOf(error);
  if (!refusal) return false;
  try {
    await send(refusalReportArgs(refusal, caller));
    return true;
  } catch {
    return false;
  }
}

export function guardRefusalMessage(refusal: GuardRefusal) {
  return `Not saved: ${refusal.message}`;
}
