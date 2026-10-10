# Usage metering and rate limits

## Usage (Organization → Usage, `matelot usage`, `GET /organizations/:id/usage`)
Per organization and calendar month (UTC):

| Metric | Definition |
|---|---|
| Active seats | Members of the organization (a role anywhere in its tree, account not disabled) who made at least one authenticated request that month — in the web app, with a personal token, or through MCP. CI tokens and runners are never seats; platform administrators without a role in the organization are not counted. |
| Members | Distinct people with a role in the organization's tree (not disabled), at computation time. |
| Runner minutes | Sum of `finished − started` for jobs run by a runner that finished in the month (also per job type). Platform jobs (policy evaluation) count as jobs but use no runner minutes. |
| Jobs / Pipelines / SBOMs | Finished jobs, pipelines started, SBOMs stored in the month. |
| Projects / Services / Environments | Inventory size (not archived) at computation time. |

The current month is computed live. The worker writes a snapshot of every organization's current month every hour and
finalises the previous month on its first pass after the month ends, so history survives job and pipeline pruning.
`?month=YYYY-MM` selects a month, `?format=csv` exports the 12-month history
(`month,seats_active,seats_members,projects,services,environments,pipelines,jobs,runner_minutes,sboms`).
Visible with `audit:read` (organization and security administrators, compliance officers, CISO, auditors).

## Rate limits
Fixed one-minute windows per caller, counted in Redis (shared by all API replicas; if Redis is unreachable each process
counts on its own and logs it once):

| Class | Key | Default / min | Env |
|---|---|---|---|
| read (GET/HEAD) | user, or CI token | 1200 | `RATE_LIMIT_READ_PER_MINUTE` |
| write | user, or CI token | 300 | `RATE_LIMIT_WRITE_PER_MINUTE` |
| runner | runner | 1200 | `RATE_LIMIT_RUNNER_PER_MINUTE` |
| anonymous | client IP | 120 | `RATE_LIMIT_ANONYMOUS_PER_MINUTE` |
| failed authentication (401) | client IP | 30 | `RATE_LIMIT_AUTH_FAILURES_PER_MINUTE` |

`0` disables a class, `RATE_LIMIT_ENABLED=false` disables all. Successful requests to `/health`, `/webhooks/*`,
`/registry/token`, `/registry/events` and `/.well-known/*` are never counted (docker pulls are bursty).

**Failed authentication** is counted separately, on every path: a 401 (bad or expired bearer token, wrong docker-login
password on `/registry/token`, bad webhook signature or registry events secret) counts against the client IP; past the
limit the 401 becomes a 429 with `Retry-After`. Requests that authenticate are never affected by their address's
failures. A 403 (authenticated, not allowed) counts against the caller's own read / write bucket. These are counted in
the global exception filter, because the guards reject them before the rate-limit interceptor runs. Responses carry `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`;
over the limit the API answers `429` with `Retry-After`. The request is refused before it runs, so the CLI (2.16.0+)
waits for `Retry-After` (≤ 60 s, up to 3 times) and repeats it — also for writes.
