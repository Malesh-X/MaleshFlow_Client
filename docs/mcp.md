# Flow MCP server (for Claude, ChatGPT and other agents)

Flow has a hosted MCP server at **https://flow.malesh.com/api/mcp**, so agents
on claude.ai, the Claude apps, ChatGPT and Claude Code can read and edit the
workspace without the Flow CLI or your Mac. It uses Streamable HTTP
(stateless) and OAuth.

It is a thin wrapper over the same Convex functions the app and the CLI use, so
link syncing, completion routing, undo receipts and the server's guards behave
the same. Output is formatted like the CLI's (`lib/flow`): readable links, the
`tree` outline with ids.

## Connecting

Each agent signs in once through Flow's own sign-in page: it shows the agent's
name and where its key will be sent, you enter your owner key and tap
**Allow**. The agent gets its own key (an access token that lasts an hour and
renews itself with a rotating refresh token). It never sees your owner key.

### claude.ai and the Claude apps

1. Settings > Connectors > **Add custom connector**.
2. Name: `Flow`. URL: `https://flow.malesh.com/api/mcp`. Leave the OAuth
   client id and secret empty.
3. Click **Connect**, enter your owner key on Flow's page, tap **Allow**.

A connector added on claude.ai also works in the Claude phone and desktop apps.

### Claude Code

```bash
claude mcp add --transport http flow https://flow.malesh.com/api/mcp
```

Then run `/mcp` in Claude Code, pick `flow` and authenticate: a browser opens on
Flow's sign-in page. Claude Code receives the key on `http://localhost:<port>`.

### ChatGPT

1. Settings > Apps & Connectors > Advanced settings: turn on **Developer mode**.
2. Settings > Apps & Connectors > **Create** (or **Add custom connector**).
3. Name: `Flow`. MCP server URL: `https://flow.malesh.com/api/mcp`.
   Authentication: **OAuth** (leave client id and secret empty; ChatGPT
   registers itself).
4. Create, then connect: enter your owner key on Flow's page and tap **Allow**.

## Tools

| Tool | Does | Read-only |
| --- | --- | --- |
| `list_pages` | Active pages as `<pageId>  <title>` (CLI `pages`). | yes |
| `read_page` | A page's outline with ids, `[ ]`/`[x]` tasks and readable links (CLI `tree`), in batches (`offset`, `parentId`; see below). | yes |
| `show_item` | One item: text, page, kind, status, dates, time, recurrence, priority, its parents and children. | yes |
| `search` | Pages by title and items by text (the app's link search). | yes |
| `add_item` | Add a note or task (end of the page's main section by default; `parentId`, `afterId`, `task`, `due`, `dueEnd`, `time`, `timeZone`) (CLI `add`). | no |
| `add_outline` | Append an outline parsed like the app's importer (CLI `add-outline`). | no |
| `update_item` | Change text, priority or kind (CLI `update --text/--priority/--task/--note`). | no |
| `schedule_item` | Due date, end date, time, recurrence, and the task's own completion basis (`dueDate`/`today`/`none`) (CLI `update --due/--due-end/--time/--recur/--recur-basis`). | no |
| `complete_item` | Complete like the app's checkbox; returns an undo receipt (CLI `done`). | no |
| `undo_complete` | Checked undo of a completion by receipt (CLI `undo-done`). | no (marked destructive) |
| `move_item` | Move an item and its branch, within a page or to another page (CLI `move`). | no |

`read_page` returns at most 450 items, and about 100,000 characters of
outline, per call, so a whole Today/This Week planner (about 400 items) comes
back in one read. A longer page is cut between items and ends with a note:

```
Showing items 1–450 of 1,203. Call read_page with offset=450 for more, or parentId=<id> to read one section.
Top-level sections:
- Focus  (…)  84 items
- …
```

- `offset` continues from that item. A batch that starts inside a branch first
  prints `(continuing under: Focus > X)` so the indentation still reads.
- `parentId` reads one item and everything under it (an item on that page, for
  example one planner day), batched the same way. On planners this is the
  cheaper read.
- Stray items print on the last batch only; the server's load warning prints
  on every batch. Archive pages (Past Weeks, Done) list newest first, as in the
  app. The CLI's `tree` is not batched.
- `show_item` shows at most 500 items under an item; when it's cut it points
  to `read_page` with `parentId`.

There is no raw `run` tool, no archive or delete, and no tool for settings or
exclusions.

Links print as `[target text](node:ID)`, `[Label → target](node:ID)` or
`[Page title](page:ID)`, as in the CLI (docs/flow-cli.md, Links in output).
Text written with `add_item`, `add_outline` or `update_item` converts them back
to stored link syntax, so copying a line from `read_page` keeps its links.

Dates are `YYYY-MM-DD`, stored as noon in the workspace's time zone (Settings),
or UTC when it has none; pass `timeZone` to choose another. A time keeps the
item's own time zone when it has one.

## What agents can't do

The server enforces this, not the MCP code:

- Agent keys work only with the Convex functions in
  `convex/lib/agentRegistry.ts`. Every other function refuses them
  (`assertOwnerKey`), including exclusions, settings, the owner key, agent
  keys, archiving and deleting pages.
- Pages and items excluded from data dumps are hidden from agents, with their
  whole subtrees, the same rule as the export (`getDataDumpVisibility`):
  `list_pages`, `read_page`, `show_item` and `search` leave them out, links to
  them print as `[(hidden)](node:ID)`, and any write that touches one (or would
  put an item inside one) is refused.
- `tests/guardCoverage.test.ts` checks that every function that accepts agent
  keys applies this rule and that every other function checks the owner key.

## Connected agents and revoking

Actions > **Show Connected Agents** lists each connected agent with where its
key goes, when it was connected and when it was last used. **Revoke** cuts it
off on its next request (its access and refresh tokens stop working). To
connect it again, sign in again from the agent.

Revoking also happens on its own when a used refresh token or authorization
code is presented again (a sign the key leaked).

## How it works

| Path | What |
| --- | --- |
| `/api/mcp` | MCP endpoint. Without a valid key: `401` with `WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/api/mcp"`. |
| `/.well-known/oauth-protected-resource` (and `/api/mcp` suffix) | RFC 9728 metadata: the resource and its authorization server (this site). |
| `/.well-known/oauth-authorization-server` | RFC 8414 metadata. |
| `/oauth/register` | Dynamic client registration (RFC 7591). Public clients only (`token_endpoint_auth_method: none`). |
| `/oauth/authorize` | The sign-in page. GET shows it; the form POSTs the owner key in the body (never a URL). |
| `/oauth/token` | `authorization_code` (PKCE S256 required) and `refresh_token`. |

- Codes are single use and last 10 minutes. Access tokens last 1 hour; refresh
  tokens last 30 days and rotate on every use.
- Codes and tokens are random values stored only as SHA-256 hashes in Convex
  (`oauthCodes`, `oauthTokens`, `oauthGrants`, `oauthClients`), with the client
  name and created, last-used and revoked times. Logic: `convex/oauth.ts`.
- The owner key check on the sign-in page uses the app's lockout
  (`recordOwnerKeyValidation`): 10 wrong keys lock sign-in, the app and the CLI
  for a while.
- Keys are only sent to these redirect URIs (`lib/domain/agentOAuth.ts`):
  - `https://claude.ai/api/mcp/auth_callback`, `https://claude.com/api/mcp/auth_callback` (Claude)
  - `https://chatgpt.com/connector_platform_oauth_redirect` and `https://chatgpt.com/connector/oauth/<id>` (ChatGPT)
  - `http://localhost:<any port>/...` and `http://127.0.0.1:<any port>/...` (Claude Code and other local clients)
- The `resource` parameter (RFC 8707), when sent, must be this server's
  `/api/mcp` URL; tokens are bound to it. Responses include `iss` (RFC 9207).
- No environment variables beyond what the app already uses
  (`NEXT_PUBLIC_CONVEX_URL`).

## Troubleshooting

| Symptom | Check |
| --- | --- |
| "Can't connect this agent … only sends keys to …" | The agent uses a redirect URI not on the list above. Add it in `lib/domain/agentOAuth.ts` if it's a real client. |
| "That owner key isn't right" / "Too many wrong keys" | The key is checked against production's `OWNER_ACCESS_TOKEN`. After 10 failures everything locks for a while. |
| A tool says "not found (or it's excluded from data dumps)" | The page or item is excluded; include it with "Show Data Dump Exclusions" if the agent should see it. |
| The agent stopped working | It was revoked, or its refresh token expired (30 days unused). Reconnect from the agent. |

Local testing: run the app against dev (`npm run dev`), then point a client at
`http://localhost:3000/api/mcp`; the sign-in page checks dev's owner key.
