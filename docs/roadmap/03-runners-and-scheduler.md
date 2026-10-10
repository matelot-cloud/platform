# Step 03 — Execution plane: runners, pools, tags, job scheduler 🔨

**Goal.** The GitLab-Runner-style execution plane from the concept: the cell schedules jobs; runners
pick them up, execute close to the customer's code and infrastructure, and report back only
findings, metadata and evidence. Source code and images never have to leave the customer network.

## Scope
1. **Runner registration & lifecycle.** Registration token per pool → runner token; heartbeat;
   tags/capabilities (`linux`, `docker`, `kubernetes`, `production`, `high-memory`, `embedded`,
   `security`, custom); version; status `online | offline | busy | draining`; drain & remove.
2. **Runner types.** *Cloud runner* (managed by us, in the cell). *Self-hosted runner* (customer
   installs: Docker image first, then VM/bare-metal single binary, then private cloud).
   *Kubernetes runner* (a controller in the customer cluster creating one Kubernetes Job per
   platform job). *Ephemeral runner* (execution environment created per job and destroyed after).
3. **Runner pools** owned by an organization, optionally restricted to workspace / team / project /
   environment; a project can require tags (`Required runner tags`).
4. **Jobs.** Types: `sbom`, `sca`, `sast`, `secrets`, `iac`, `container-scan`, `kubernetes-check`,
   `config-analysis`, `license-check`, `artifact-scan`, `policy-eval`, `custom`. Target (service,
   repository @ ref, image, environment), required tags, priority, timeout, retries, payload.
   States `queued → assigned → running → succeeded | failed | cancelled | timed_out`.
5. **Scheduler.** Tag + pool matching, long-poll pickup, lease with expiry, requeue on lost
   heartbeat, per-pool concurrency, fairness across projects.
6. **Runner agent** (`apps/runner`, TypeScript, container image; protocol documented so a Go
   binary can implement it later): poll → prepare isolated workspace → run tool → stream logs →
   upload results (JSON) and artifacts (object storage: MinIO bundled in the cell, S3-compatible
   external in production) → report.
7. **Secure runner architecture.** Runners execute only jobs created through the platform after
   RBAC and policy checks; the AI (step 15) reaches runners only via `trigger_security_job`.
8. UI: Runners (pools, runners, tags, health), Jobs (queue, running, history, live logs, artifacts).

## Data model
`runner_pools`, `runner_registration_tokens`, `runners`, `jobs`, `job_events`, `job_artifacts`,
`object_store` config. Permissions: `runner:read/write/register`, `job:read/create/cancel`.

## Acceptance criteria
- [ ] Register a self-hosted runner (Docker) with the one-liner shown in the UI; it appears online.
- [ ] A queued `custom` job is picked up within 5 s; logs stream live; results and artifacts stored.
- [ ] Killing a runner mid-job requeues after lease expiry; retries and timeouts respected.
- [ ] Managed pool runs jobs as ephemeral Kubernetes Jobs in kind; Kubernetes runner controller runs in a second kind cluster.
- [ ] A runner never receives a job outside its pool's scope or without matching tags (tests).
- [ ] `docs/runner-protocol.md` specifies the runner ↔ cell protocol.

## Progress log
* Slice 1 (done): pools at any level (org/workspace/team/project, inherited downward), one-time
  registration tokens with ready-made Docker / Compose / source commands, runner identity tokens,
  heartbeats, atomic claim (`FOR UPDATE SKIP LOCKED`, tag ⊆ match, scope on the project path),
  60 s leases, sweeper in the worker (requeue / time out / offline), batched idempotent logs,
  just-in-time repository credentials (GitHub App installation token, stored token/password, SSH
  deploy key), `repository_check` and `custom` job types, `apps/runner` agent (+ Dockerfile),
  `docs/runner-protocol.md`, UI: Runners (org/workspace/project), Jobs with live logs, "Run
  repository check" on a service. Migration `0005`. Verified: register → clone over SSH →
  logs → result; tag gating; SIGKILL mid-job → requeued → finished by a restarted runner; cancel.
* Slice 1b (done): **pipelines** (GitLab model) — built-in templates (`security`: source →
  inventory → scan → policy; `checkout`), per-project numbering, stages advance when the previous
  one finished, failure fails the pipeline and skips the rest, cancel, retry of a finished job;
  runners report job types they don't implement as `skipped` so the security pipeline is honest
  today and lights up as scanners ship. UI: Pipelines list with mini stage graph, pipeline page with
  stage columns and job cards, job page with log viewer/result/retry, Jobs list with filters,
  Runners redesigned (summary tiles, Runners/Pools tabs, guided registration, runner details), "Run
  pipeline ▾" on services. Migration `0006`.
* Slice 2 (next): managed runners in the cell (Helm Deployment), Kubernetes runner controller,
  ephemeral per-job Kubernetes Jobs, object storage for artifacts (MinIO), per-pool concurrency.
