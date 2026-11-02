# Resolve Links Safety and Workspace Feature Removal

Status: planned; application changes have not started.

## Summary

Prevent Resolve Empty Links from creating a node link to its own source node,
and remove AI Chat, Inbox, and Random Box from the workspace experience and
their dedicated backend APIs. Preserve existing content, exports, and the
shared code supporting other features.

These are two independently shippable changes. They do not depend on the
broader business-logic centralization plan in `docs/server-logic-plan.md`.

## Scope

| Area                | Intended result                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Resolve Empty Links | Server-enforced self-link protection, appropriate target-menu exclusions, and accurate replacement/skip reporting.            |
| AI Chat             | Remove workspace conversation, memory editor, proposed-action approval, pinned/unpinned panels, and all entry points.         |
| Inbox               | Remove capture dialogs, draft editing, autosave, clear-to-history action, and all entry points.                               |
| Random Box          | Remove list editing, random selection, autosave, and all entry points.                                                        |
| Existing content    | Retain stored text, historical chat records, AI memory metadata, and Inbox History pages.                                     |
| Other features      | Preserve model rewriting, journal feedback, symbol mode, planner task suggestions, search, screenshot import, and embeddings. |

This work does not repair existing self-links, detect general multi-node link
cycles, purge saved content, or change planner completion and recurrence rules.

## Current Code Map

| File                                   | Relevant responsibilities                                                                                              |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `components/UnresolvedLinksPanel.tsx`  | Grouped target search, parent-target checkbox, confirmation, and batched replacement loop.                             |
| `convex/workspace.ts`                  | Unresolved-link groups and replacement mutations; Inbox, Random Box, and AI memory APIs.                               |
| `components/WorkspaceApp.tsx`          | Floating buttons, dialogs, chat panels, subscriptions, drafts, shortcuts, navigation, titles, and saved preferences.   |
| `lib/domain/workspaceLocation.ts`      | `aiChat` panel state and `panel=ai-chat` URL handling.                                                                 |
| `convex/ai.ts`                         | Workspace chat/question answering alongside retained search, screenshot parsing, embedding, and task-metadata actions. |
| `convex/chat.ts`, `convex/chatData.ts` | Chat actions and plan application alongside helpers still used by model rewriting and journal feedback.                |
| `convex/importExportData.ts`           | Existing Inbox and Random Box data-dump exports.                                                                       |
| `convex/schema.ts`                     | Shared `chatThreads` and `chatMessages` tables.                                                                        |

Use symbol names and current call sites during implementation; line numbers
will change as the large workspace component is reduced.

## Track A: Resolve Empty Links

### Authoritative Replacement Rule

For a node target, never rewrite matching unresolved links inside the target
node itself. Enforce this inside
`replaceUnresolvedPageLinksWithTargetBatch`, before a candidate consumes a batch
slot or is patched.

Both public entry points must inherit the same rule:

- `workspace:replaceUnresolvedPageLinksWithTarget`
- `workspace:replaceUnresolvedPageLinksWithNode`

The server must enforce the rule even when called directly, with stale UI
state, or after the parent-target checkbox changes the effective target.
Page-target replacements keep their current behavior.

Examples:

| Situation                                                  | Result                                                   |
| ---------------------------------------------------------- | -------------------------------------------------------- |
| Item A contains `[[topic]]`; target is A                   | Leave A's text unchanged.                                |
| A and B contain `[[topic]]`; target is A                   | Resolve B to A; leave A's own unresolved link unchanged. |
| A contains several matching links; target is A             | Skip all matching occurrences in A.                      |
| The selected child's parent becomes the effective target A | Apply the same self-link rule to A.                      |

Do not strip brackets or invent replacement text for a skipped self-link.
The unresolved label remains available for resolution to a different target.

### Target Menu and Parent Selection

- When a group has exactly one verified source node, exclude that node from
  the target menu using the shared query's existing `excludeNodeId` argument.
- Do not infer the full source set from `samples`: samples are capped. Expose
  a small additive field such as `soleSourceNodeId` from the grouping query
  when the scan is complete and the group has exactly one source. Treat a
  truncated scan as incomplete information.
- For a group with multiple sources, allow a source node to serve as the
  canonical target for the other sources. Blanket exclusion of every source
  would prevent that useful resolution.
- Evaluate the effective target after applying "Use selected item's parent."
  Disable applying a known self-only choice, including a parent choice, with
  a concise explanation. The backend remains authoritative if data changes.
- Keep shortest-label-first ordering and existing page/node target formatting.
- Keep inline `[[` autocomplete ranking, Shift-click, and Shift+Enter parent
  selection behavior unchanged.

### Counts, Progress, and Partial Results

- Return additive metadata identifying the skipped target node and the number
  of matching self-link occurrences left unchanged.
- Sum actual replacement counts across batches. Deduplicate skipped metadata
  by node ID; do not add the same target's skipped occurrences on every batch.
- Compute continuation from eligible replacements. A skipped self-link alone
  must never keep `hasMore` true or cause repeated zero-progress requests.
- Preserve scan caps and show existing truncation warnings. Do not claim the
  whole workspace was resolved when only a bounded scan was processed.
- Update confirmation, progress, and completion copy to distinguish replaced
  links from self-links left unchanged. A no-op caused by self-link protection
  must not be presented as a successful replacement.
- Leave residual unresolved labels visible. The UI must not automatically
  retry the same self-only group or silently hide it permanently.

## Track B: Remove the Three Workspace Features

### Interface and Client Behavior

Remove all dedicated controls and rendering from `WorkspaceApp.tsx`:

- AI Chat, Inbox, and Random Box floating buttons and any menu/action entries.
- Unpinned and pinned AI Chat panels, chat messages, source previews, memory
  editing, proposed-action approval, and chat-specific loading/error states.
- Inbox and Random Box dialogs, box tabs, add-box controls, editors, random
  selection, and clear-to-history controls.
- Dedicated keyboard shortcuts, shortcut-help entries, focus management,
  outside-click handlers, Escape handling, and related event listeners.
- State, refs, subscriptions, mutation/action hooks, draft synchronization,
  autosave timers, and local helper functions used only by these features.
- Layout branches and reserved space for full-page or pinned chat.

The floating toolbar should size to its remaining controls. Preserve the
command palette, pinned actions and custom symbols, undo/redo, mobile editing
toolbar, and other workspace navigation.

### URLs, Titles, and Preferences

- Remove the `aiChat` panel variant and all code that writes new AI Chat URLs.
- Treat an existing `panel=ai-chat` URL as a retired panel: open the underlying
  page/focused node, clear the retired panel parameters with history replace,
  and retain unrelated query parameters.
- Ensure browser Back/Forward and old bookmarks do not reopen a removed
  panel, crash, or leave the workspace hidden. Preserve other palette URLs.
- Remove AI Chat browser-title branches and restore normal page/palette titles.
- Retire only the chat-open and chat-pinned browser-storage keys. Remove known
  legacy copies from local/session storage where applicable; do not clear
  workspace preferences wholesale.

### Dedicated Backend Removal

Audit runtime callers before deleting code. The final backend should no longer
expose active APIs for these retired features.

Candidates for removal in the combined feature-removal release:

- Inbox: `getWorkspaceInbox`, `setWorkspaceInbox`, `clearWorkspaceInbox`, and
  the now-unused Inbox History creation helper.
- Random Box: `getWorkspaceRandomBox`, `setWorkspaceRandomBox`.
- Chat memory: `getWorkspaceAiMemory`, `setWorkspaceAiMemory`, and
  `getAiWorkingMemoryContext`, when no retained runtime caller requires them.
- Workspace chat: `chatWithWorkspace`, `answerWorkspaceQuestion`, workspace
  knowledge-thread APIs, and their chat-only context and memory helpers.
- Conversational planning: `runChatPlanner`, `runPlannerChat`,
  `applyApprovedChatPlan`, and `applyApprovedPlannerPlan`, after confirming
  they have no caller outside the retired chat flows.
- Unused chat-only domain types, prompts, parsing helpers, and corresponding
  tests after retained callers have been accounted for.

The current `getAiWorkingMemoryContext` call chain has been checked:

- `answerWorkspaceQuestionInternal` reads it and is reached through
  `answerWorkspaceQuestion` and `chatWithWorkspace`.
- `maybePlanAiWorkingMemoryAction` also reads it, but is called only by
  `chatWithWorkspace`.

Both branches belong to the retired workspace-chat functionality; no retained
feature currently reaches the memory-action branch. Remove these branches
together, and repeat the caller search during implementation if code changes.

Preserve `rewriteModelSection`, `generateJournalFeedback`, and the helpers they
call. Model rewriting currently uses `ensureChatThread`, `getThreadMessages`,
`storeUserMessage`, and `storeAssistantMessage`; section replacement is shared
as well. Do not delete entire chat/AI modules based on their filenames.

Keep `chatThreads` and `chatMessages` in the schema. Preserve shared page
deletion cleanup and any retained references to those tables. Keep OpenAI and
other dependencies needed by retained features. Regenerate Convex API types
with the supported tooling after endpoint changes; do not edit generated
types manually.

## Content Preservation

| Content                     | Handling                                                                                                                                                                                        |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saved Inbox/Random Box text | Keep the existing sidebar-page metadata, including legacy single-text and current multi-box forms.                                                                                              |
| Inbox/Random Box backups    | Preserve existing `workspace/inbox.md` and `workspace/random-box.md` data-dump output and normalization helpers. Exports must read stored metadata directly rather than depend on retired APIs. |
| Inbox History               | Retain existing pages and their nodes as ordinary archived content. Remove only the retired feature's ability to create new history captures.                                                   |
| Historical conversations    | Retain thread/message records, pending-plan records, and metadata. Retention does not make retired approval actions executable.                                                                 |
| AI working memory           | Retain the stored metadata; remove its active editor and chat behavior.                                                                                                                         |

No content migration or destructive cleanup is required. Stored historical
content and export readers are intentional remaining references to retired
feature names. Do not add new automatic exports of chat history or change
existing data-dump exclusion rules as part of this removal.

Any later workspace-data inspection or repair must follow `docs/flow-cli.md`:
use the Flow CLI, preview production writes with `--dry-run`, and apply them
with `--prod --yes`. No migration or one-off production data edits are part
of this implementation.

## Delivery Order

1. **Resolve Links safety.** Add the shared backend guard and additive result
   metadata, then the menu/parent checks and accurate reporting. Verify both
   public mutations and the UI. This can ship independently.
2. **Combined feature removal.** Remove all three interfaces, subscriptions,
   client behavior, navigation/preferences, dedicated APIs, and unreachable
   helpers in one release. Preserve shared functionality and export readers,
   and regenerate API types.

This is a single-user workspace. Before deploying feature removal, make sure
Inbox, Random Box, and AI memory edits are saved and their autosaves have
finished. After the frontend and backend deployment finishes, reload all open
workspace tabs to load the new build. Older builds subscribe to retired
queries even when the panels are closed, so reloading applies to every open
workspace tab. No compatibility release, temporary endpoints, or version-cutoff
machinery is required.

Each implementation release should have focused commits and verification.
Pushes to `master` trigger the configured Vercel/Convex deployment, so finish
the relevant checks before pushing. Coordinate endpoint removals with the
separate server-logic plan's mutation inventory rather than adding new APIs
for Inbox or Random Box there.

## Verification

### Required Automated Coverage

Keep new coverage focused on four areas:

1. **Mutation-level self-link protection.** Cover both public entry points,
   a self-only target, and a target that is also one of several source items.
   Verify that the target stays unchanged while other matching items resolve.
2. **Batch progress.** A skipped self-link must not consume replacement slots
   or keep `hasMore` true after eligible replacements are exhausted. Check
   self-only termination and skipped counts across multiple batches.
3. **Retired chat URL.** An old `panel=ai-chat` URL opens the underlying page
   or focused node, clears retired panel parameters, and preserves unrelated
   location parameters.
4. **Export preservation.** Saved multi-box and legacy single-box Inbox/Random
   Box content remains in the same data-dump files after API removal.

Test the server rule through mutations, not only through a client filter or
pure helper. Follow the project's Convex test guidelines when adding coverage.

### One Manual Acceptance Pass

- Check desktop and mobile: the three features' buttons, panels, menus,
  shortcuts, and reserved space are absent; remaining floating controls and
  pinned actions fit and work.
- Exercise editing, undo/redo, selection, scheduling, page navigation, the
  command palette, and mobile keyboard controls.
- Check old bookmarks, Back/Forward, saved chat preferences, and browser titles.
- Check resolver menu exclusion, multi-source targets, parent targeting,
  skipped-link messages, and residual unresolved groups.
- Verify shortest-label ordering, compact/custom/page link replacements, and
  inline autocomplete's Shift-click and Shift+Enter parent behavior.
- Exercise retained AI actions on development data: model rewriting, journal
  feedback, search, symbol mode, screenshot import, and planner task suggestions.
  Check that retained embedding jobs still run.

### Required Implementation Checks

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Run these checks for application changes, together with the four focused test
areas and one manual pass above. Document any pre-existing warnings.
For the plan-document-only commit, run formatting and diff checks. Do not
invoke a manual Convex deployment; the existing push pipeline may still run.

## Completion Checklist

- [ ] Both resolver mutations prevent newly created direct self-links.
- [ ] Menu, parent targeting, batching, and reporting follow the rules above.
- [ ] AI Chat, Inbox, and Random Box have no active UI or client behavior.
- [ ] Dedicated backend APIs are removed in the feature-removal release.
- [ ] Existing content, shared tables, exports, and retained features survive.
- [ ] Focused tests, required checks, and manual acceptance pass.
- [ ] Pending text is saved before deployment; open tabs are reloaded afterward.
- [ ] Implementation commits are pushed and the deployment is verified.

Implementation is complete only when backend retirement is finished; hiding
buttons alone does not complete this plan.
