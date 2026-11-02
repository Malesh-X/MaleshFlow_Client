# Flow CLI (for agents and scripts)

`scripts/flow.ts` reads and edits MaleshFlow workspace data from the terminal.
It calls the same Convex functions the web app uses, so link syncing,
embeddings and AI hooks run exactly as they do for edits made in the UI.
Prefer it over driving the web app in a browser: one command per change,
plain-text output with ids you can check.

Run from the repo root:

```bash
npm run -s flow -- <command> [args] [flags]
```

## Targets and safety

| Flag | Effect |
| --- | --- |
| _(none)_ | Dev deployment from `.env.local` (usually empty; good for trying things). |
| `--prod` | Production (`precise-coyote-972`, override with `MALESHFLOW_PROD_URL`). This is the real workspace. |
| `--yes` | Required for any write with `--prod`. |
| `--dry-run` | Prints the Convex function and args a write would send, then exits without sending. |
| `--json` | Raw JSON output for `pages` and `tree`. |

Auth: every function needs the owner key. The CLI uses `MALESHFLOW_OWNER_KEY`
if set, otherwise reads `OWNER_ACCESS_TOKEN` with `npx convex env get`
(needs the Convex CLI to be logged in). Never print or commit the key.

Workflow for production edits: read first (`pages`, `tree`), run the write with
`--dry-run`, then run it again with `--prod --yes`, then `tree` again to confirm.

## Commands

| Command | What it does |
| --- | --- |
| `pages` | List active pages as `<pageId>  <title>`. Journal pages are titled `YYYY-MM-DD`. |
| `tree <pageId>` | Print the page outline with node ids. Tasks show `[ ]` / `[x]`. |
| `add-page <title> [--section Notes]` | Create a page. Sections: Models, Tasks, Notes, Views, Templates, Journal, Scratchpads. Prints the new page id. |
| `rename-page <pageId> <title>` | Rename a page. |
| `add <pageId> <text>` | Add a node at the end of the page. Prints the new node id. |
| &nbsp;&nbsp;`--parent <nodeId>` | Nest under a node (appends after its last child). |
| &nbsp;&nbsp;`--after <nodeId>` / `--after top` | Place after a specific sibling, or first. |
| &nbsp;&nbsp;`--task`, `--due YYYY-MM-DD` | Make it a task (`--due` implies `--task`). |
| `add-outline <pageId> <file\|->` | Append a markdown outline in one batch (see below). `-` reads stdin. |
| `update <nodeId>` | Change a node: `--text "…"`, `--status todo\|in_progress\|done\|cancelled`, `--due YYYY-MM-DD\|none`, `--task` / `--note`. |
| `done <nodeId>` | Mark a task done. |
| `archive <nodeId>` | Archive (hide) a node. Reversible: `run mutation workspace:archiveNode '{"nodeId":"…","archived":false}'`. |
| `run query\|mutation <module:fn> '<json>'` | Call any public Convex function; `ownerKey` is added for you. See `convex/workspace.ts` for the full list. |

### Outline format for `add-outline`

```markdown
- Plain note
  - Nested note (2-space indent)
  - [ ] Open task
    - Deeper child
- [x] Done task
```

Lines that don't start with `-` or `*` are ignored.

## Examples

```bash
# Find a page and look at it
npm run -s flow -- pages --prod | grep -i surfing
npm run -s flow -- tree <pageId> --prod

# Add a task with a due date to the end of a page
npm run -s flow -- add <pageId> "Book flights" --due 2026-11-15 --prod --dry-run
npm run -s flow -- add <pageId> "Book flights" --due 2026-11-15 --prod --yes

# Edit and complete nodes
npm run -s flow -- update <nodeId> --text "Book flights to Lisbon" --prod --yes
npm run -s flow -- done <nodeId> --prod --yes

# Paste a block of notes
cat notes.md | npm run -s flow -- add-outline <pageId> - --prod --yes
```

## Notes

- Node text supports the app's inline syntax (page links, tags); links are synced on write.
- `tree` hides archived nodes; `--json` prints the raw query result.
- Deleting pages for good (`deletePageForever`) is irreversible. Archive instead unless the owner asks.
