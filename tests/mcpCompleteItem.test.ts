import test from "node:test";
import assert from "node:assert/strict";
import { completeItem, type FlowCalls } from "../lib/mcp/tools";

// complete_item ignores a leftover workspace completionMode: mode argument,
// else "today" (the task's own basis is applied on the server).
function fakeFlow(sent: Record<string, unknown>[]): FlowCalls {
  return {
    query: async (path) => {
      if (path === "workspace:getWorkspaceSettings") return { timeZone: null, completionMode: "dueDate" };
      if (path === "workspace:getNodeDetail") {
        return {
          node: { _id: "n1", pageId: "p1", parentNodeId: null, position: 0, text: "Gym", kind: "task", taskStatus: "todo", archived: false, revision: 3 },
          page: { _id: "p1", title: "Tasks", archived: false },
          ancestors: [],
          nodes: [],
          truncated: false,
        };
      }
      throw new Error(`unexpected query ${path}`);
    },
    mutation: async (path, args) => {
      assert.equal(path, "workspace:setNodeCompletion");
      sent.push(args!);
      return { status: "applied", route: "recurring", receiptId: null };
    },
  };
}

test("complete_item defaults to today even with a stored workspace dueDate", async () => {
  const sent: Record<string, unknown>[] = [];
  await completeItem(fakeFlow(sent), { nodeId: "n1" });
  assert.equal(sent[0]!.completionMode, "today");
});

test("complete_item passes an explicit mode through", async () => {
  const sent: Record<string, unknown>[] = [];
  await completeItem(fakeFlow(sent), { nodeId: "n1", mode: "dueDate" });
  assert.equal(sent[0]!.completionMode, "dueDate");
});
