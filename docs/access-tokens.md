# Access tokens

| Token | For | Acts as | Reach |
|---|---|---|---|
| **CI token** (project → Settings → CI tokens) | pipelines | the token itself | its scope (project/team/…), its preset, its *May deploy to* list |
| **Personal access token** (user menu → Access tokens) | people: scripts, the API, `matelot` on a laptop | the user | see scopes below |
| **Service-account token** (a scope's Members → Service accounts) | integrations and automation that need a *role*: Jira sync, Renovate, a reporting job | a bot user owned by that scope | the bot's memberships (that scope and below) masked by `read` / `write` |

## Personal token scopes
The scope is a mask over the user's own roles (never a different role) — the full permission × scope table is in
[roles.md](roles.md#token-scopes-personal-tokens-matelot-login-claude-ai-connectors):
* **read** — `GET`/`HEAD` only: everything the user can see, nothing changes.
* **write** (default of `matelot login`) — everything the user's roles allow **except** administration (organization
  settings, members and roles, integrations, policies / channels / SLAs, approvals, runner pools, compliance) and any
  `DELETE` (archiving or removing). An administrator's write token creates workspaces, teams and projects, runs
  pipelines and pushes to the registry.
* **sudo** — administrators only: the user's full rights, including organization / platform administration and deletes.

A normal user's token therefore reaches exactly the projects they are assigned to; an admin's everyday token does the
day-to-day work without being able to administer or delete, and admin power is opt-in per (short-lived) sudo token.

## Service accounts (bots)

A service account is a non-human user owned by an organization, workspace, team or project (GitLab: service accounts
and group / project access tokens). It has no password and cannot sign in with a browser; it holds roles through
ordinary memberships — only at the scope that owns it and below — and authenticates with its tokens, which are
personal access tokens of the bot: same `spt_` format, same `read` / `write` mask (never `sudo`), expiry (at most
`SERVICE_ACCOUNT_TOKEN_MAX_DAYS`, default 365), last use, rotation (a new token with the same name, scope and
lifetime; the old one stops at once) and revocation. In member lists it carries a *bot* badge; its username is a
reserved address (`bot-<name>-<id>@<scope>.bots.matelot.invalid`) nobody can sign in with.

*New access token* (GitLab "project access token") creates the bot, its role and a token in one step:
`matelot access-token create --scope projects/ID --name Renovate --role DEVELOPER --token-scope write --days 90`.

**Service account or CI token?** They are not two ways of doing the same thing:

| | CI token | Service account |
|---|---|---|
| Is | a credential of one scope, no identity | an identity (a bot user) with roles |
| Rights | a permission preset (`pipeline`, `deploy`, `registry`, `full`) + the environments it may deploy to | the roles of its memberships, masked by the token's read / write scope |
| Authenticates | HMAC-signed requests (key id + secret, the secret never travels) | bearer token `spt_…` |
| For | pipelines: SBOM upload, gates, releases, deployments, registry push / promote | integrations and automation acting as a member: reading findings, managing remediations, syncing issues |
| Managed at | Project / scope → Settings → CI tokens | Members → Service accounts |

## Security properties
* `spt_` + 240 random bits; only the SHA-256 is stored; shown once.
* Expiry 1–365 days; revocable; last use (time, IP) tracked.
* A personal token cannot create or revoke tokens (sign in to the web app); CI tokens neither. Service-account tokens
  are managed by whoever holds `membership:write` at the bot's scope (sudo or the web session).
* Created / revoked events are audited in every organization the user belongs to.
* Everything done with a token is audited as the user.

## Use
```bash
curl -H "Authorization: Bearer spt_…" https://<cell>/api/v1/me
export SECOPS_URL=https://<cell> SECOPS_TOKEN=spt_…   # matelot CLI as yourself
matelot whoami
```
The built-in registry `docker login` still uses a CI token (`matelot registry login` with SECOPS_KEY_ID/SECRET).

## API collection and checks
`tools/api/`: `secops-api-check.mjs` (calls every GET endpoint with your token and reports PASS / DENIED / FAIL),
`secops.postman_collection.json` and `secops.http` (every operation), `README.md` (everyday curl calls).
