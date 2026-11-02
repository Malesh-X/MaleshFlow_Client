# Flow CLI (for agents and scripts)

`scripts/flow.ts` reads and edits MaleshFlow workspace data from the terminal.
It calls the same Convex functions the web app uses, so link syncing,
embeddings and AI hooks run exactly as they do for edits made in the UI.
Prefer it over driving the web app in a browser: one command per change,
plain-text output with ids you can check.

Run from the repo root:

```bash
npm run -s flow -- <command> [args] [flags]
npm run -s flow -- help        # works offline, no credentials needed
```

## Setup

1. `npm install` (the CLI uses `tsx` and `convex` from devDependencies/dependencies).
2. `npx convex login` once per machine, as an account on the `maleshflow` Convex project.
   That login is how the CLI fetches the owner key (see Auth below).
3. Dev only: `.env.local` must exist with `NEXT_PUBLIC_CONVEX_URL`. `npx convex dev --once`
   creates it and also pushes the current backend code to the dev deployment.

## Targets and safety

| Flag | Effect |
| --- | --- |
| _(none)_ | Dev deployment from `.env.local`. Usually empty; good for trying things. |
| `--prod` | Production (`precise-coyote-972`, override with `MALESHFLOW_PROD_URL`). This is the real workspace. |
| `--yes` | Required for any write with `--prod`. |
| `--dry-run` | Prints each Convex function and arguments a write would send, without sending. Commands that make two writes print both. |
| `--json` | Raw JSON output for `pages`, `tree` and `doctor`. |

What `--dry-run` does **not** do: it doesn't validate the write against the
backend (bad ids or values only fail on the real run), and it still needs
credentials because write commands read the live page first to check ids and
work out where to append. Checks the CLI makes itself (locked items, loops,
parents on another page) do run in a dry run.

Workflow for production edits: read first (`pages`, `tree`), run the write with
`--dry-run`, run it again with `--prod --yes`, then `tree` again to confirm.

## Auth

Every Convex function checks an owner key against the deployment's
`OWNER_ACCESS_TOKEN` env var. The CLI uses `MALESHFLOW_OWNER_KEY` if set,
otherwise runs `npx convex env get OWNER_ACCESS_TOKEN [--prod]` using your
Convex login. Never print, log or commit the key. The CLI replaces it with
`<ownerKey>` in error messages.

## Commands

| Command | What it does |
| --- | --- |
| `pages` | List active pages as `<pageId>  <title>`. Journal pages are titled `YYYY-MM-DD`. |
| `tree <pageId>` | Print the page outline with node ids. Tasks show `[ ]` / `[x]`. Archived nodes are hidden. Stray items (active, but their parent is archived, missing or on another page) are listed at the end. |
| `add-page <title> [--section Tasks] [--type planner]` | Create a page the way the app's sidebar `+` does: the section sets the page type (Models → model, Tasks → task, Notes → note, Views → view, Journal → journal, Scratchpads → scratchpad, Templates → plain) and the server adds that type's sections. Journal pages are also added to the Latest Journal view. `--type planner` makes a planner (Tasks section only). Default section: Tasks. Prints the page id. |
| `rename-page <pageId> <title>` | Rename a page. |
| `add <pageId> <text>` | Add a node at the end of the page's main section (Note, Template, Scratchpad, Thoughts/Stuff, Model, Included Pages/Nodes), or the page root on task and plain pages. Planner pages need `--parent`. Prints the node id. |
| &nbsp;&nbsp;`--parent <nodeId>` | Nest under a node on the same page (appends after its last child). |
| &nbsp;&nbsp;`--after <nodeId>` / `--after top` | Place after a specific item (and under its parent), or first. |
| &nbsp;&nbsp;`--task`, `--due YYYY-MM-DD`, `--time HH:MM` | Make it a task, with a due date and optional time (`--due` implies `--task`; `--time` needs `--due`). |
| `add-outline <pageId> <file\|->` | Append a markdown outline in one batch (see below) to the same place `add` would. `-` reads stdin. |
| `update <nodeId>` | Change a node with any of the flags below. |
| &nbsp;&nbsp;`--text "…"` | Replace the text. |
| &nbsp;&nbsp;`--status todo\|done` | Task status (tasks only). `done` runs `done` (below), so it can't be combined with other flags; `--mode` applies. `todo` reopens. |
| &nbsp;&nbsp;`--due YYYY-MM-DD\|none`, `--time HH:MM\|none` | Schedule or unschedule. `none` clears due date, end date, time, time zone and recurrence. A new due date drops an end date that isn't after it. |
| &nbsp;&nbsp;`--priority low\|medium\|high\|none` | Priority. |
| &nbsp;&nbsp;`--recur daily\|weekly\|monthly\|yearly\|<n>d\|<n>w\|<n>m\|<n>y\|none` | Recurrence, e.g. `2w` = every 2 weeks. |
| &nbsp;&nbsp;`--task` / `--note` | Change the node kind like the app's toggle: locks the kind (so AI tagging won't flip it back) and resets status, dates and recurrence. Not allowed on section headers or planner days. |
| `done <nodeId> [--mode dueDate\|today]` | Complete an item exactly like the app's checkbox (see below). `--mode` sets how recurring tasks roll forward (default `dueDate`, the app's default). Never reopens: an item that is already done is left alone. |
| `move <nodeId>` | Move a node and its whole branch; appends at the end of the destination by default. Section headers and planner days can't be moved. |
| &nbsp;&nbsp;`--page <pageId>` | Another page: re-pages the whole branch with `moveNodeTreesToPage` (like the app's "Move to page"), landing at the page root unless `--parent`/`--after` place it there. |
| &nbsp;&nbsp;`--parent <nodeId>\|root` | New parent, on the destination page. Refused if it's the item itself or inside it. |
| &nbsp;&nbsp;`--after <nodeId>\|top` | Exact position among the new siblings (`--after <id>` also sets the parent). |
| `archive <nodeId>` / `unarchive <nodeId>` | Hide or restore a node and its whole branch (`setNodeTreeArchived`, as in the app). Section headers and planner days can't be archived. Unarchive is refused when the parent is archived too; unarchive the parent instead. |
| `doctor [--limit 5]` | Read-only data check across all active pages (see below). Prints counts and a few examples per check; `--json` prints everything. |
| `run query\|mutation <module:fn> '<json>'` | Call a public Convex query or mutation; `ownerKey` is added for you. Actions are not supported. Functions live in `convex/*.ts`; check the `args` validator there for names and types. |

Unknown commands, unknown flags, missing arguments and bad values are rejected
locally, before anything connects.

### How `done` completes items

`done` looks up the item's page and takes the same path as the app's checkbox:

| Item | Convex function | Effect |
| --- | --- | --- |
| Planner day or focus item (or a planner copy of a task) | `planner:completePlannerTask` | Marks it done; once the day's items are all done the day moves to Past Weeks and linked source tasks are completed. |
| Root task on a task page with "archive completed tasks to Done" on | `workspace:completeTaskPageTask` | Moves it to the Done page (recurring tasks roll forward instead). |
| Recurring task with a due date, anywhere else | `workspace:updateNode` | Stays open and moves to its next due date. |
| Any other task | `workspace:updateNode` | `taskStatus: "done"`. |

The dry run prints which path it picked. `update --status done` takes the same
path. An item that is already done (or already archived by a completion) is
left alone and the CLI says so; neither command ever reopens a task. To reopen
a plain task, use `update --status todo`.

### `doctor` checks

`doctor` only reads (`listPages`, `getPageTree`, `resolveNodeLinks`) and never
writes, so it needs no `--yes`. It reports:

| Check | Means |
| --- | --- |
| Stray items | Active items whose parent is archived, missing or on another page. The app can't show them under a parent. |
| Untyped pages | Pages in Models, Journal, Views or Scratchpads still typed `default`, so they never got their sections. |
| Notes with a task status | A note carrying `todo`/`done`. |
| Recurring items with no due date | Recurrence set but nothing to roll forward from. |
| End date not after the due date | `dueEndAt` on or before `dueAt`, or with no due date. |
| Pages too large to check fully | The page tree was capped, so results for that page may be incomplete. |

Repairs are a separate step that the owner approves (Phase 5 of
docs/server-logic-plan.md).

### Dates and times

`--due 2026-11-15` is stored as **local noon** in the time zone of the machine
running the CLI, the same as the app's date picker (`dateInputValueToTimestamp`).
Run it on a machine set to your usual time zone. `--time` also records that
machine's time zone (e.g. `Pacific/Honolulu`).

### Outline format for `add-outline`

```markdown
- Plain note
  - Nested note (2-space indent)
  - [ ] Open task
    - Deeper child
- [x] Done task
```

Lines that don't start with `-` or `*` are ignored. Items are plain notes or
tasks; set dates, priority or recurrence afterwards with `update`.

## Examples

```bash
# Find a page and look at it
npm run -s flow -- pages --prod | grep -i surfing
npm run -s flow -- tree <pageId> --prod

# Add a scheduled task to the end of a page
npm run -s flow -- add <pageId> "Book flights" --due 2026-11-15 --time 09:00 --prod --dry-run
npm run -s flow -- add <pageId> "Book flights" --due 2026-11-15 --time 09:00 --prod --yes

# Edit, prioritize, make recurring, complete
npm run -s flow -- update <nodeId> --text "Book flights to Lisbon" --priority high --prod --yes
npm run -s flow -- update <nodeId> --recur weekly --prod --yes
npm run -s flow -- done <nodeId> --prod --yes

# Move a node under another one on the same page, or to the top of another page
npm run -s flow -- move <nodeId> --parent <newParentId> --prod --yes
npm run -s flow -- move <nodeId> --page <otherPageId> --after top --prod --yes

# Check the data for damage (read-only)
npm run -s flow -- doctor --prod

# Paste a block of notes
cat notes.md | npm run -s flow -- add-outline <pageId> - --prod --yes

# Anything else via run (check the function's args in convex/workspace.ts)
npm run -s flow -- run query workspace:listTasks '{}' --prod
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Could not read OWNER_ACCESS_TOKEN` | Run `npx convex login`; confirm the token exists with `npx convex env list [--prod]`; or set `MALESHFLOW_OWNER_KEY`. |
| `Invalid owner access token` | The key doesn't match that deployment (dev and prod have separate tokens). |
| `pages` prints nothing | You're on dev, which is usually empty. Add `--prod`. |
| `ArgumentValidationError ... extra field` on dev | Dev runs older backend code than the repo. Run `npx convex dev --once` to push it. |
| `Page not found` / `Node not found` | Ids are per deployment; an id from `--prod` won't exist on dev. |
| `No .env.local found` | Run `npx convex dev --once`, or use `--prod`. |

## Notes

- Node text supports the app's inline syntax (page links, tags); links are synced on write.
- `run mutation` calls a Convex function directly and skips every check above
  (locks, loops, page types). Prefer the dedicated commands.
- Deleting pages for good (`deletePageForever`) is irreversible. Archive instead unless the owner asks.
