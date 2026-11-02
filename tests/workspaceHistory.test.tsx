import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useEffect, useMemo, useRef, useState } from "react";
import { ConvexError } from "convex/values";
import type { Id } from "../convex/_generated/dataModel";
import {
  WorkspaceHistoryProvider,
  focusElementAtEnd,
  getNodeEditorId,
  getPageTitleEditorId,
  type NodeValueSnapshot,
  type TrackedEditorTarget,
  useWorkspaceHistory,
  useWorkspaceHistoryController,
} from "../components/workspaceHistory";

const PAGE_ONE = "page-1" as Id<"pages">;
const PAGE_TWO = "page-2" as Id<"pages">;
const NODE_ONE = "node-1" as Id<"nodes">;
const NODE_TWO = "node-2" as Id<"nodes">;

function installDom() {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });

  const { window } = dom;
  Object.defineProperties(globalThis, {
    window: { value: window, configurable: true },
    document: { value: window.document, configurable: true },
    navigator: { value: window.navigator, configurable: true },
    HTMLElement: { value: window.HTMLElement, configurable: true },
    HTMLInputElement: { value: window.HTMLInputElement, configurable: true },
    HTMLTextAreaElement: { value: window.HTMLTextAreaElement, configurable: true },
    Event: { value: window.Event, configurable: true },
    KeyboardEvent: { value: window.KeyboardEvent, configurable: true },
    MouseEvent: { value: window.MouseEvent, configurable: true },
    InputEvent: { value: window.InputEvent, configurable: true },
    getComputedStyle: {
      value: window.getComputedStyle.bind(window),
      configurable: true,
    },
    IS_REACT_ACT_ENVIRONMENT: { value: true, configurable: true, writable: true },
  });

  const htmlElementPrototype = window.HTMLElement.prototype as HTMLElement & {
    attachEvent?: () => void;
    detachEvent?: () => void;
  };

  if (!htmlElementPrototype.attachEvent) {
    Object.defineProperty(htmlElementPrototype, "attachEvent", {
      value: () => undefined,
      configurable: true,
    });
  }

  if (!htmlElementPrototype.detachEvent) {
    Object.defineProperty(htmlElementPrototype, "detachEvent", {
      value: () => undefined,
      configurable: true,
    });
  }

  return dom;
}

function TrackedTitleInput({
  pageId,
  committedValue,
  onCommit,
}: {
  pageId: Id<"pages">;
  committedValue: string;
  onCommit: (nextValue: string) => Promise<void>;
}) {
  const history = useWorkspaceHistory();
  const [draft, setDraft] = useState(committedValue);
  const draftRef = useRef(draft);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorId = getPageTitleEditorId(pageId);
  const target = useMemo(
    () =>
      ({
        kind: "page_title",
        pageId,
      } satisfies TrackedEditorTarget),
    [pageId],
  );

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    setDraft(committedValue);
  }, [committedValue]);

  useEffect(() => {
    return history.registerEditor(editorId, target, committedValue, {
      getElement: () => inputRef.current,
      getValue: () => draftRef.current,
      setValue: setDraft,
      focusAtEnd: () => focusElementAtEnd(inputRef.current),
    });
  }, [committedValue, editorId, history, target]);

  useEffect(() => {
    history.syncCommittedValue(editorId, committedValue, target);
  }, [committedValue, editorId, history, target]);

  const commitDraft = async () => {
    await onCommit(draft);
    const before = history.commitTrackedValue(editorId, target, draft);
    if (before !== draft) {
      history.pushUndoEntry({
        type: "rename_page",
        pageId,
        beforeTitle: before,
        afterTitle: draft,
        focusEditorId: editorId,
      });
    }
  };

  return (
    <div>
      <input
        ref={inputRef}
        data-testid="page-title"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          history.updateDraftValue(editorId, target, event.target.value);
        }}
        onBlur={() => void commitDraft()}
      />
      <button
        data-testid="checkpoint-title"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => history.flushDraftCheckpoint(editorId)}
      >
        Checkpoint Title
      </button>
      <button
        data-testid="commit-title"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void commitDraft()}
      >
        Commit Title
      </button>
    </div>
  );
}

function TrackedNodeInput({
  pageId,
  nodeId,
  committedValue,
  onCommit,
}: {
  pageId: Id<"pages">;
  nodeId: Id<"nodes">;
  committedValue: string;
  onCommit: (nextValue: string) => Promise<void>;
}) {
  const history = useWorkspaceHistory();
  const [draft, setDraft] = useState(committedValue);
  const draftRef = useRef(draft);
  const inputRef = useRef<HTMLInputElement>(null);
  const editorId = getNodeEditorId(nodeId);
  const target = useMemo(
    () =>
      ({
        kind: "node",
        pageId,
        nodeId,
      } satisfies TrackedEditorTarget),
    [nodeId, pageId],
  );

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    setDraft(committedValue);
  }, [committedValue]);

  useEffect(() => {
    return history.registerEditor(editorId, target, committedValue, {
      getElement: () => inputRef.current,
      getValue: () => draftRef.current,
      setValue: setDraft,
      focusAtEnd: () => focusElementAtEnd(inputRef.current),
    });
  }, [committedValue, editorId, history, target]);

  useEffect(() => {
    history.syncCommittedValue(editorId, committedValue, target);
  }, [committedValue, editorId, history, target]);

  const commitDraft = async () => {
    await onCommit(draft);
    const before = history.commitTrackedValue(editorId, target, draft);
    if (before !== draft) {
      const beforeSnapshot: NodeValueSnapshot = {
        text: before,
        kind: "note",
        taskStatus: null,
        noteCompleted: false,
      };
      const afterSnapshot: NodeValueSnapshot = {
        text: draft,
        kind: "note",
        taskStatus: null,
        noteCompleted: false,
      };
      history.pushUndoEntry({
        type: "update_node",
        pageId,
        nodeId,
        before: beforeSnapshot,
        after: afterSnapshot,
        focusEditorId: editorId,
      });
    }
  };

  return (
    <div>
      <input
        ref={inputRef}
        data-testid="node-input"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          history.updateDraftValue(editorId, target, event.target.value);
        }}
        onBlur={() => void commitDraft()}
      />
      <button
        data-testid="commit-node"
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => void commitDraft()}
      >
        Commit Node
      </button>
    </div>
  );
}

function HistoryHarness() {
  const [selectedPageId, setSelectedPageId] = useState(PAGE_ONE);
  const [pageTitles, setPageTitles] = useState<Record<string, string>>({
    [PAGE_ONE]: "Page One",
    [PAGE_TWO]: "Page Two",
  });
  const [nodeTexts, setNodeTexts] = useState<Record<string, string>>({
    [NODE_ONE]: "Alpha",
    [NODE_TWO]: "Beta",
  });

  const history = useWorkspaceHistoryController({
    ownerKey: "owner",
    selectedPageId,
    setSelectedPageId: (pageId) => {
      if (pageId) {
        setSelectedPageId(pageId);
      }
    },
    renamePage: async ({ pageId, title }) => {
      setPageTitles((current) => ({
        ...current,
        [pageId]: title,
      }));
    },
    updateNode: async ({ nodeId, text }) => {
      setNodeTexts((current) => ({
        ...current,
        [nodeId]: text ?? current[nodeId],
      }));
    },
    moveNode: async () => undefined,
    setNodeTreeArchived: async () => undefined,
    setNodeTreesArchivedBatch: async () => undefined,
    undoCompletion: async () => null,
    redoCompletion: async () => null,
    undoTextEditAndCompletion: async () => null,
    redoTextEditAndCompletion: async () => null,
    draftCheckpointDelayMs: 20,
  });

  const currentNodeId = selectedPageId === PAGE_ONE ? NODE_ONE : NODE_TWO;

  return (
    <WorkspaceHistoryProvider value={history}>
      <div>
        <div data-testid="selected-page">{selectedPageId}</div>
        <button data-testid="select-page-1" onClick={() => setSelectedPageId(PAGE_ONE)}>
          Page 1
        </button>
        <button data-testid="select-page-2" onClick={() => setSelectedPageId(PAGE_TWO)}>
          Page 2
        </button>
        <button
          data-testid="undo"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void history.undo()}
          disabled={!history.canUndo}
        >
          Undo
        </button>
        <button
          data-testid="redo"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => void history.redo()}
          disabled={!history.canRedo}
        >
          Redo
        </button>
        <TrackedTitleInput
          pageId={selectedPageId}
          committedValue={pageTitles[selectedPageId]}
          onCommit={async (nextValue) => {
            setPageTitles((current) => ({
              ...current,
              [selectedPageId]: nextValue,
            }));
          }}
        />
        <TrackedNodeInput
          pageId={selectedPageId}
          nodeId={currentNodeId}
          committedValue={nodeTexts[currentNodeId]}
          onCommit={async (nextValue) => {
            setNodeTexts((current) => ({
              ...current,
              [currentNodeId]: nextValue,
            }));
          }}
        />
        <input data-testid="chat-input" defaultValue="" />
      </div>
    </WorkspaceHistoryProvider>
  );
}

test("live typing undo and redo works inside a node editor", { concurrency: false }, async () => {
  const dom = installDom();
  const user = userEvent.setup({ document: dom.window.document });
  const view = render(<HistoryHarness />);

  const nodeInput = view.getByTestId("node-input") as HTMLInputElement;
  await user.click(nodeInput);
  await user.clear(nodeInput);
  await user.type(nodeInput, "Alpha plus");
  await waitFor(() => {
    assert.equal((view.getByTestId("undo") as HTMLButtonElement).disabled, false);
  });

  await user.keyboard("{Control>}z{/Control}");
  assert.equal(nodeInput.value, "Alpha");

  await user.keyboard("{Control>}{Shift>}z{/Shift}{/Control}");
  assert.equal(nodeInput.value, "Alpha plus");

  cleanup();
  dom.window.close();
});

// A completion undo the server refuses: the message is shown, the step is
// dropped, and older steps stay available. Other failures keep the step.
function CompletionHarness({ undoCompletion }: { undoCompletion: () => Promise<unknown> }) {
  const [message, setMessage] = useState("");
  const history = useWorkspaceHistoryController({
    ownerKey: "owner",
    selectedPageId: PAGE_ONE,
    setSelectedPageId: () => undefined,
    renamePage: async () => undefined,
    updateNode: async () => undefined,
    moveNode: async () => undefined,
    setNodeTreeArchived: async () => undefined,
    setNodeTreesArchivedBatch: async () => undefined,
    undoCompletion,
    redoCompletion: async () => null,
    undoTextEditAndCompletion: async () => null,
    redoTextEditAndCompletion: async () => null,
    onHistoryMessage: setMessage,
  });
  const pushed = useRef(false);
  useEffect(() => {
    if (pushed.current) return;
    pushed.current = true;
    history.pushUndoEntry({ type: "archive_node_tree", pageId: PAGE_ONE, nodeId: NODE_ONE, focusAfterUndoId: null, focusAfterRedoId: null });
    history.pushUndoEntry({ type: "completion_receipt", pageId: PAGE_ONE, receiptIds: ["r1"], focusEditorId: null });
  }, [history]);
  return (
    <div>
      <div data-testid="message">{message}</div>
      <button data-testid="undo" onClick={() => void history.undo()}>
        Undo
      </button>
      <div data-testid="counts">{`${history.canUndo}/${history.canRedo}`}</div>
    </div>
  );
}

test("a refused completion undo shows the server's message and drops that step", { concurrency: false }, async () => {
  const dom = installDom();
  const user = userEvent.setup({ document: dom.window.document });
  const calls: number[] = [];
  const view = render(
    <CompletionHarness
      undoCompletion={async () => {
        calls.push(1);
        throw new ConvexError({ code: "undoRefused", message: `Can't undo this completion: "Task" was changed. Nothing was undone.` });
      }}
    />,
  );
  await waitFor(() => assert.equal(view.getByTestId("counts").textContent, "true/false"));
  await user.click(view.getByTestId("undo"));
  await waitFor(() => assert.match(view.getByTestId("message").textContent ?? "", /"Task" was changed/));
  // The refused step is gone; the older archive step is still there to undo.
  assert.equal(view.getByTestId("counts").textContent, "true/false");
  await user.click(view.getByTestId("undo"));
  await waitFor(() => assert.equal(view.getByTestId("counts").textContent, "false/true"));
  assert.equal(calls.length, 1);
  cleanup();
  dom.window.close();
});

test("a failed completion undo keeps the step and says so", { concurrency: false }, async () => {
  const dom = installDom();
  const user = userEvent.setup({ document: dom.window.document });
  const view = render(
    <CompletionHarness
      undoCompletion={async () => {
        throw new Error("Network down");
      }}
    />,
  );
  await waitFor(() => assert.equal(view.getByTestId("counts").textContent, "true/false"));
  await user.click(view.getByTestId("undo"));
  await waitFor(() => assert.equal(view.getByTestId("message").textContent, "Couldn't undo: Network down"));
  assert.equal(view.getByTestId("counts").textContent, "true/false");
  cleanup();
  dom.window.close();
});

// A text edit and a completion in one step: undo and redo each go to the
// server as one call that checks first and writes both or nothing. No
// separate text write is sent, so a refused step can't overwrite newer text.
type TextEditStepArgs = { receiptIds: string[]; nodeId: string; edit: { text: string } };
function CompoundHarness({
  calls,
  undoStep,
  redoStep,
}: {
  calls: string[];
  undoStep?: (args: TextEditStepArgs) => Promise<unknown>;
  redoStep?: (args: TextEditStepArgs) => Promise<unknown>;
}) {
  const [message, setMessage] = useState("");
  const snapshot = (text: string): NodeValueSnapshot => ({ text, kind: "task", taskStatus: "todo", noteCompleted: false });
  const history = useWorkspaceHistoryController({
    ownerKey: "owner",
    selectedPageId: PAGE_ONE,
    setSelectedPageId: () => undefined,
    renamePage: async () => undefined,
    updateNode: async ({ text }) => {
      calls.push(`text:${text}`);
    },
    moveNode: async () => undefined,
    setNodeTreeArchived: async () => undefined,
    setNodeTreesArchivedBatch: async () => undefined,
    undoCompletion: async () => {
      calls.push("undoCompletion");
      return null;
    },
    redoCompletion: async () => {
      calls.push("redoCompletion");
      return null;
    },
    undoTextEditAndCompletion: async (args) => {
      calls.push(`undoStep:${args.edit.text}:${args.receiptIds.join(",")}`);
      return undoStep ? undoStep(args) : null;
    },
    redoTextEditAndCompletion: async (args) => {
      calls.push(`redoStep:${args.edit.text}:${args.receiptIds.join(",")}`);
      return redoStep ? redoStep(args) : null;
    },
    onHistoryMessage: setMessage,
  });
  const pushed = useRef(false);
  useEffect(() => {
    if (pushed.current) return;
    pushed.current = true;
    history.pushUndoEntry({
      type: "compound",
      pageId: PAGE_ONE,
      entries: [
        { type: "update_node", pageId: PAGE_ONE, nodeId: NODE_ONE, before: snapshot("Draft"), after: snapshot("Draft, edited"), focusEditorId: "editor" },
        { type: "completion_receipt", pageId: PAGE_ONE, receiptIds: ["r1"], focusEditorId: null },
      ],
      focusAfterUndoId: null,
      focusAfterRedoId: null,
    });
  }, [history]);
  return (
    <div>
      <div data-testid="message">{message}</div>
      <button data-testid="undo" onClick={() => void history.undo()}>
        Undo
      </button>
      <button data-testid="redo" onClick={() => void history.redo()}>
        Redo
      </button>
      <div data-testid="counts">{`${history.canUndo}/${history.canRedo}`}</div>
    </div>
  );
}

const refused = (verb: "undone" | "redone") => async () => {
  throw new ConvexError({ code: "undoRefused", message: `Can't ${verb === "undone" ? "undo" : "redo"} this completion: "Draft" was changed. Nothing was ${verb}.` });
};

test("undo and redo of a text edit plus completion each go to the server as one call", { concurrency: false }, async () => {
  const dom = installDom();
  const user = userEvent.setup({ document: dom.window.document });
  const calls: string[] = [];
  const view = render(<CompoundHarness calls={calls} />);
  await waitFor(() => assert.equal(view.getByTestId("counts").textContent, "true/false"));
  await user.click(view.getByTestId("undo"));
  await waitFor(() => assert.equal(view.getByTestId("counts").textContent, "false/true"));
  await user.click(view.getByTestId("redo"));
  await waitFor(() => assert.equal(view.getByTestId("counts").textContent, "true/false"));
  assert.deepEqual(calls, ["undoStep:Draft:r1", "redoStep:Draft, edited:r1"]);
  cleanup();
  dom.window.close();
});

test("a refused redo of a text edit plus completion sends no text write first", { concurrency: false }, async () => {
  const dom = installDom();
  const user = userEvent.setup({ document: dom.window.document });
  const calls: string[] = [];
  const view = render(<CompoundHarness calls={calls} redoStep={refused("redone")} />);
  await waitFor(() => assert.equal(view.getByTestId("counts").textContent, "true/false"));
  await user.click(view.getByTestId("undo"));
  await waitFor(() => assert.equal(view.getByTestId("counts").textContent, "false/true"));
  await user.click(view.getByTestId("redo"));
  await waitFor(() => assert.match(view.getByTestId("message").textContent ?? "", /Nothing was redone/));
  assert.equal(view.getByTestId("counts").textContent, "false/false");
  assert.deepEqual(calls, ["undoStep:Draft:r1", "redoStep:Draft, edited:r1"]);
  cleanup();
  dom.window.close();
});

test("a refused undo of a text edit plus completion sends no text write", { concurrency: false }, async () => {
  const dom = installDom();
  const user = userEvent.setup({ document: dom.window.document });
  const calls: string[] = [];
  const view = render(<CompoundHarness calls={calls} undoStep={refused("undone")} />);
  await waitFor(() => assert.equal(view.getByTestId("counts").textContent, "true/false"));
  await user.click(view.getByTestId("undo"));
  await waitFor(() => assert.match(view.getByTestId("message").textContent ?? "", /Nothing was undone/));
  assert.equal(view.getByTestId("counts").textContent, "false/false");
  assert.deepEqual(calls, ["undoStep:Draft:r1"]);
  cleanup();
  dom.window.close();
});
