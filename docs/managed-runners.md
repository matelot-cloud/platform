# Managed runners

A fresh cell runs pipelines without the customer installing anything: the Helm chart deploys the cell's own runner
agents (a StatefulSet), which register into the **Managed** pool and run jobs for every organization and project of
the cell. Self-hosted pools stay for jobs that must reach the customer's network (private git hosts, registries,
Kubernetes clusters).

## How it works
- The chart generates `MANAGED_RUNNER_SECRET` on first install (Secret `<release>-managed-runner`, kept across
  upgrades like the encryption key) and gives it to the API and to the runners.
- On every start a managed runner registers with that secret (`POST /runner/register { managedSecret, name }`). The
  platform creates the Managed pool on first use (one per cell, under the bootstrap organization) and replaces the
  record of the same name, so pod restarts never pile up offline duplicates. If its token is no longer accepted
  (record removed), the agent registers again by itself.
- The Managed pool serves every organization of the cell (the claim skips the organization / scope filter for it);
  required tags still apply. It carries the tag `managed`; the agent adds `linux` (and `docker` when it has a daemon).
  Managed runners get no Kubernetes API access, and the agent never adds the `kubernetes` tag by itself when it runs
  with `RUNNER_MANAGED_SECRET` (even though it runs inside a cluster and ships kubectl), so cluster-inventory jobs
  stay on customer runners. `managedRunners.tags` can still add it deliberately.
- While the API is unreachable (cell restore, upgrade, ingress reload) a managed runner keeps retrying registration,
  heartbeats and claims with backoff (2 s → 60 s) instead of exiting; only a definite answer such as a 401 (wrong
  secret) stops it.
- The pool is read-only for customers: it cannot be deleted and has no registration tokens. It is listed on every
  Runners page ("managed by the platform").
- Runners of the Managed pool not seen for a day (scaled-down ordinals, deleted pods) are pruned by the worker; a
  busy runner never is.
- Usage: runner minutes are split — `runnerMinutesManaged` (and the CSV column `runner_minutes_managed`) is the part
  run on managed runners.

## Helm values
```yaml
managedRunners:
  enabled: true        # false removes the StatefulSet (the Secret is kept)
  replicas: 1          # 0 stops them
  image: { repository: ghcr.io/matelot-io/runner, tag: "" }   # tag defaults to the chart appVersion
  tags: []
  secret: ""           # empty = generated and kept
  resources: { requests: { cpu: 250m, memory: 512Mi }, limits: { cpu: "2", memory: 2Gi } }
  workDirSize: 4Gi
```
`make kind-load` builds and loads the runner image; `make deploy` points `managedRunners.image` at it.

Without the chart (local development): start the API with `MANAGED_RUNNER_SECRET=<48 chars>` and a runner with
`RUNNER_URL=… RUNNER_MANAGED_SECRET=<same> RUNNER_NAME=managed-0 node apps/runner/dist/index.js`.
