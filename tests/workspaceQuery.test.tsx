import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { ConvexProvider, type ConvexReactClient } from "convex/react";
import { getFunctionName, makeFunctionReference, type FunctionReference } from "convex/server";
import { useWorkspaceQuery } from "../components/useWorkspaceQuery";
import { AppStatusBanner, useConvexHealth } from "../components/appUpdate";
import {
  OUTDATED_WRITE_MESSAGE,
  convexHealth,
  createConvexHealthStore,
  describeWriteError,
  isOutdatedClientError,
} from "../lib/domain/convexHealth";
import { decideStaleTabAction } from "../lib/domain/appVersion";

const MISSING_FUNCTION_ERROR =
  "[CONVEX Q(workspace:listPages)] [Request ID: 1] Server Error\nCould not find public function for 'workspace:listPages'.";

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
  Object.defineProperties(globalThis, {
    window: { value: dom.window, configurable: true },
    document: { value: dom.window.document, configurable: true },
    navigator: { value: dom.window.navigator, configurable: true },
    HTMLElement: { value: dom.window.HTMLElement, configurable: true },
    Event: { value: dom.window.Event, configurable: true },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true, writable: true },
  });
  Object.defineProperties(dom.window.HTMLElement.prototype, {
    attachEvent: { value: () => undefined, configurable: true },
    detachEvent: { value: () => undefined, configurable: true },
  });
  return dom;
}

// Just enough of ConvexReactClient for useQueries: one result per query name,
// set by the test, which the watch returns or throws like the real client.
function createFakeClient() {
  const results = new Map<string, { value: unknown } | { error: Error }>();
  const listeners = new Set<() => void>();
  const client = {
    watchQuery(query: FunctionReference<"query">) {
      const name = getFunctionName(query);
      return {
        onUpdate(callback: () => void) {
          listeners.add(callback);
          return () => listeners.delete(callback);
        },
        localQueryResult() {
          const result = results.get(name);
          if (!result) return undefined;
          if ("error" in result) throw result.error;
          return result.value;
        },
        journal: () => undefined,
      };
    },
  };
  return {
    client: client as unknown as ConvexReactClient,
    set(name: string, result: { value: unknown } | { error: Error }) {
      results.set(name, result);
      for (const listener of [...listeners]) listener();
    },
  };
}

const listPages = makeFunctionReference<"query", { ownerKey: string }, string[]>("workspace:listPages");

function Pages({ ownerKey }: { ownerKey: string | null }) {
  const pages = useWorkspaceQuery(listPages, ownerKey ? { ownerKey } : "skip");
  const health = useConvexHealth();
  return (
    <div>
      <p data-testid="pages">{pages === undefined ? "loading" : pages.join(",")}</p>
      <AppStatusBanner health={health} stale={false} />
    </div>
  );
}

test("a failing query keeps its last value and shows the banner instead of throwing", async () => {
  const dom = installDom();
  convexHealth.reset();
  const fake = createFakeClient();
  try {
    const screen = render(
      <ConvexProvider client={fake.client}>
        <Pages ownerKey="key" />
      </ConvexProvider>,
    );
    assert.equal(screen.getByTestId("pages").textContent, "loading");

    act(() => fake.set("workspace:listPages", { value: ["Inbox", "Journal"] }));
    await waitFor(() => assert.equal(screen.getByTestId("pages").textContent, "Inbox,Journal"));
    assert.equal(screen.queryByRole("status"), null);

    // A deploy removed the function this old bundle subscribes to.
    act(() => fake.set("workspace:listPages", { error: new Error(MISSING_FUNCTION_ERROR) }));
    await waitFor(() => assert.match(screen.getByRole("status").textContent ?? "", /Flow was updated\./));
    assert.equal(screen.getByTestId("pages").textContent, "Inbox,Journal");
    assert.ok(screen.getByRole("button", { name: "Reload" }));
    assert.equal(convexHealth.getSnapshot().problem?.kind, "outdated");

    // The subscription recovers: the banner goes away.
    act(() => fake.set("workspace:listPages", { value: ["Inbox"] }));
    await waitFor(() => assert.equal(screen.getByTestId("pages").textContent, "Inbox"));
    await waitFor(() => assert.equal(screen.queryByRole("status"), null));
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("a query failing with no earlier value stays loading, and unmounting clears its problem", async () => {
  const dom = installDom();
  convexHealth.reset();
  const fake = createFakeClient();
  fake.set("workspace:listPages", { error: new Error("[CONVEX Q(workspace:listPages)] Server Error") });
  try {
    const screen = render(
      <ConvexProvider client={fake.client}>
        <Pages ownerKey="key" />
      </ConvexProvider>,
    );
    await waitFor(() => assert.match(screen.getByRole("status").textContent ?? "", /can't load the latest data/));
    assert.equal(screen.getByTestId("pages").textContent, "loading");
    screen.rerender(
      <ConvexProvider client={fake.client}>
        <Pages ownerKey={null} />
      </ConvexProvider>,
    );
    await waitFor(() => assert.equal(convexHealth.getSnapshot().problem, null));
  } finally {
    cleanup();
    dom.window.close();
  }
});

test("only out-of-date errors from writes count, and they keep a message for the toast", () => {
  const store = createConvexHealthStore();
  assert.equal(store.reportWriteError(new Error("Item changed since you loaded it")), false);
  assert.equal(store.getSnapshot().problem, null);
  assert.equal(
    store.reportWriteError(new Error("[CONVEX M(chatData:applyApprovedChatPlan)] Could not find public function for 'chatData:applyApprovedChatPlan'"), 5),
    true,
  );
  assert.equal(store.getSnapshot().lastFailedWriteAt, 5);
  assert.equal(store.getSnapshot().problem?.kind, "outdated");
  assert.equal(describeWriteError(new Error("ArgumentValidationError: Object contains extra field `x`"), "x"), OUTDATED_WRITE_MESSAGE);
  assert.equal(describeWriteError(new Error("Too many attempts"), "fallback"), "Too many attempts");
  assert.equal(describeWriteError(null, "fallback"), "fallback");
  assert.equal(isOutdatedClientError("Could not find public function for 'a:b'"), true);
});

test("an outdated query problem outranks other server errors", () => {
  const store = createConvexHealthStore();
  store.reportQueryError("a", "workspace:listTags", new Error("Server Error"));
  assert.equal(store.getSnapshot().problem?.kind, "server");
  store.reportQueryError("b", "workspace:listPages", new Error(MISSING_FUNCTION_ERROR));
  assert.equal(store.getSnapshot().problem?.kind, "outdated");
  store.clearQueryError("b");
  assert.equal(store.getSnapshot().problem?.kind, "server");
  store.clearQueryError("a");
  assert.equal(store.getSnapshot().problem, null);
});

test("a stale tab with a failing Convex call reloads as soon as it is safe", () => {
  const base = { safe: true, away: false, returning: false, staleForMs: 0, reloadAllowed: true };
  assert.equal(decideStaleTabAction(base), "wait");
  assert.equal(decideStaleTabAction({ ...base, hasConvexProblem: true }), "reload");
  assert.equal(decideStaleTabAction({ ...base, hasConvexProblem: true, safe: false }), "notify");
  assert.equal(decideStaleTabAction({ ...base, hasConvexProblem: true, reloadAllowed: false }), "notify");
});
