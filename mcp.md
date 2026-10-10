# MCP server — use Matelot from Claude

The API embeds an MCP server (Streamable HTTP, stateless) at `POST /api/v1/mcp`. Every REST endpoint
is exposed as a tool, generated from the OpenAPI document at boot, so anything added to the API is
available to Claude without extra work. Tool names follow the controller and method
(`vulnerabilities_project_summary`, `remediation_project_queue`, `policies_from_template_project`,
`remediation_issue`, `cra_readiness_service`, `notification_channels_create_project`, …); scoped routes
get one tool per scope (`…_workspaces`, `…_teams`).

## Auth

Personal access tokens (Account → Access tokens; `spt_…`):
- **read** — Claude can query everything (findings, gate results, fix-first queue, risk, CRA readiness,
  evidence summaries) and cannot change anything: non-GET tools are refused by the MCP layer.
- **write** — Claude can also create exceptions, remediations, issues, policies, channels, run pipelines.
- **sudo** — administrators only.

Calls run through the normal HTTP layer: the same RBAC (your memberships), validation and audit trail
apply, attributed to your user. A session JWT from the web app also works.

## Per-user behaviour

The MCP is the user's own view of the platform, derived from their token on every request:

| Token | Who | Tools listed | Can change |
|---|---|---|---|
| web session or **sudo** token of a platform administrator | cell admin | all (incl. `admin_*`, organizations, runners) | everything |
| **write** token | regular member | everything except admin routes | only inside their workspace / team / project memberships (organization-admin roles do not count on these tokens, by design) |
| **read** token | regular member | GET tools only | nothing |

On `initialize` the instructions include an identity block ("You are acting as … — regular member / platform administrator", token scope, memberships with ids), so Claude knows which scopes it may talk about and does not guess outside them. Tools that are hidden are also refused if called by name. Every call is authorised by the API's RBAC with the same rules as the web app and CLI, and audited under the user.

## Connect

```
matelot mcp            # prints the snippets for your cell
matelot mcp --check    # handshake + tool count
```

Claude Code:
```
claude mcp add --transport http matelot https://matelot.example.com/api/v1/mcp --header "Authorization: Bearer spt_…"
```
Claude Desktop (`claude_desktop_config.json`):
```json
{ "mcpServers": { "matelot": { "type": "http", "url": "https://matelot.example.com/api/v1/mcp", "headers": { "Authorization": "Bearer spt_…" } } } }
```
**claude.ai (web and mobile):** Settings → Connectors → Add custom connector → URL `https://<your cell>/api/v1/mcp`.
No token to paste: claude.ai discovers the cell's OAuth server (`/.well-known/oauth-authorization-server`), registers
itself, sends you to Matelot's consent page where you choose read-only / read & write, and receives a token that is a
personal access token of yours (revocable under Account → Access tokens; refreshed automatically). The cell must be
reachable from the internet over HTTPS, and `API_PUBLIC_URL` must be set to that public URL.

**CLI without pasting tokens:** `matelot login --url https://<your cell>` opens the browser for the same consent and
stores the token in `~/.config/matelot/credentials.json` (refreshed when it expires; `matelot logout` revokes it).

## What Claude can do with it

- "Why is `payment-api` blocked in prod?" → gate evaluation → failing rule → the findings behind it → existing exceptions.
- "What should we fix first this sprint?" → remediation queue for the workspace, grouped by service.
- "Track the top three and open Jira issues" → `remediation_create` + `remediation_issue` (asks before writing).
- "Draft an exception for CVE-2024-1234 in demo, 90 days, reason: not reachable" → `policies_create_exception_service`.
- "Are we CRA-ready for release 1.9.9?" → `cra_readiness_service` + `evidence_summary`.
- "Which services still run an image with a KEV in production?" → `vulnerabilities_environments_org` with `kev=true`.

The server's `instructions` text (sent on initialize) explains the hierarchy, how to discover ids and to
confirm before any change; deployments are meant to stay in CI.

## Parity with the web app and the CLI

The MCP tool set is generated from the OpenAPI document, so it is exactly the public API. `apps/api/src/parity.spec.ts`
asserts that every web-app action goes through a documented route (= an MCP tool) and that every mutating route also has
a `matelot` command. Anything you can click, Claude can do (within the token's permissions), and so can a script.
`docs/parity-matrix.md` lists every route with its UI / API / CLI / MCP coverage.

## Working with large answers

Every GET tool accepts two extra parameters handled by the MCP layer: `max_items` (default 50, max 500)
keeps only the first N items of a list, `fields` (comma-separated) keeps only those keys on each item.
When a list is cut, the answer starts with "Showing N of M items…". Use the tool's own filters
(severity, status, kev, q, running) to narrow first. Output is compact JSON, capped at 60 kB.

`matelot_start_here` (always first in the tool list) returns the server instructions and the identity
block, for clients that do not surface the `initialize` instructions to the model.

## Implementation

`apps/api/src/mcp/`: `mcp.service.ts` (tool generation from the OpenAPI document, execution via loopback
HTTP with the caller's Authorization header, output truncation at 60 kB), `mcp.controller.ts` (JSON-RPC:
initialize, ping, tools/list, tools/call; notifications → 202; GET → 405). Excluded routes: auth, oauth,
health, runner protocol, webhooks, registry v2, binary downloads. `main.ts` passes the OpenAPI document to
`McpService.load`. Read-only personal tokens are allowed to POST to `/mcp` only (transport); the MCP
layer enforces GET-only tools for them.
