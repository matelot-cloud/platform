# Service coverage

Two separate questions:

* **Organization setup** (`matelot onboarding`, the "Set up your organization" card) covers one-time, organization-level
  steps: connect source code, get a runner working, and optionally send alerts somewhere and invite the team. Only
  administrators see it. Once completed it never comes back.
* **Service coverage** (`matelot coverage`, the Coverage pages) asks whether *every* service is under watch. It never
  "completes": a new service starts with gaps, and a service that has not been scanned for a while goes stale.

Counting "at least one somewhere in the organization" hid gaps. 3 of 4 services with a repository read as "done".
Coverage is counted per service.

## Checks (per service)

| Check | ok when | otherwise |
| --- | --- | --- |
| `repository` | a repository is attached to the service | gap: `matelot repository attach --service <id> --repository-id <id>` |
| `pipeline` | a pipeline of the service finished (succeeded or failed) within the last N days (default 30, `--days` / `?days=` 1–365) | **stale** when the last one finished earlier, gap when none ever finished: `matelot pipeline --service <id> --template security --wait` |
| `sbom` | the service has an SBOM | gap: `matelot sbom --service <id> --file bom.json --target source` (or run the pipeline) |
| `policy` | an enabled policy applies: on the service or one of its environments, or **inherited** from its project, team, workspace or organization | gap: `matelot policy from-template-project --project <id> --template production-baseline` |
| `deployment` | a deployment of the service was recorded in any environment | gap: `matelot deploy --env <id> --image <ref>` (or `matelot env create …` first when the service has no environment) |

Every gap comes with the web page that fixes it and the CLI command with the ids filled in.

## Where

* **Project → Coverage**: one row per service, a check or a gap per column. Under each uncovered row are the
  commands that close its gaps. It follows the project's service selector.
* **Overview → Service coverage**: e.g. "3/4 with a repository · 2/4 scanned in the last 30 days · …". Each number links
  to `/coverage?gap=<check>`, the uncovered services across the organization filtered by that check.
* Visible to everyone who can read the project. The organization view counts only the projects the viewer can read.

## API

* `GET /projects/:projectId/coverage?days=&gap=&uncovered=true` (`project:read`) returns `{ projectId, days, summary, services[] }`.
* `GET /organizations/:organizationId/coverage?days=&gap=&limit=` (`organization:read`, filtered per project by
  `project:read`) returns `{ days, gap, summary, uncoveredTotal, uncovered[] }`. `gap` narrows the list but never the summary.
* `summary = { services, covered, checks: { <check>: { ok, stale, missing } } }`. Each service has
  `{ covered, gaps[], checks[]: { id, state: ok|stale|missing, detail, href, cli } }`.

## CLI

```
matelot coverage                          # organization: per-check counts + services with gaps
matelot coverage --gap pipeline           # only services not scanned in the window
matelot coverage --project <id>           # the project's table
matelot coverage --project <id> --uncovered   # only the gaps, each with the command that fixes it
matelot coverage --days 7 --json
```
