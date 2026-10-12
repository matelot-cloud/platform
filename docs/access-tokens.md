# Access tokens

| Token | For | Acts as | Reach |
|---|---|---|---|
| **CI token** (project → Settings → CI tokens) | pipelines | the token itself | its scope (project/team/…), its preset, its *May deploy to* list |
| **Personal access token** (user menu → Access tokens) | people: scripts, the API, `secops` on a laptop | the user | see scopes below |

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

## Security properties
* `spt_` + 240 random bits; only the SHA-256 is stored; shown once.
* Expiry 1–365 days; revocable; last use (time, IP) tracked.
* A personal token cannot create or revoke tokens (sign in to the web app); CI tokens neither.
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
