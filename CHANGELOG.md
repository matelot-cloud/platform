# Changelog

## v0.1.0 — first self-hosted release

Images `ghcr.io/matelot-cloud/{api,web,worker,runner}` and the chart `oci://ghcr.io/matelot-cloud/charts/secops-cell`, signed, with SBOM attestations; install guide at https://matelot-cloud.github.io/website/docs/latest/install.html. The sections below are the drops that make up the release, newest first.

### Observability drop 1 fix-up 3: probe pods without a verdict are retried, client polls and worker timers leave no traces of their own (CLI 2.24.2)

- `checks`: "the probe pod gave no verdict" right after a rollout (the curl pod's output empty while the API answered
  seconds later) is no longer a failure: `probe_cell` shares the 60 s budget between the curl loop and the pod
  itself and retries an empty verdict; when it persists the last pod is kept and its phase, last event and logs are
  printed. `cell-provision.test.sh` covers two empty pods then READY (passes, says so) and a persisting one (fails
  with the diagnostics).
- `matelot pipeline --wait` (and the correlation wait) send each poll with an unsampled W3C traceparent, like the
  runner's log batches, and the cell's sampler (`telemetry/sampler.ts`) records no root trace for `GET
  /pipelines/:id`, `/pipelines/:id/jobs`, `/jobs/:id`, `/jobs/:id/logs` and the correlation job endpoint from any
  client that sends nothing; a poll inside a traced request stays its child. 69 root traces in 20 minutes → 0.
- The orphan `pg.query:SELECT platform` root span was the worker's signing-keys load at module initialisation (320
  ms, the first connection). Both the api's and the worker's module initialisation now run with instrumentation
  suppressed (the api starts listening outside that context, so requests stay traced); every worker timer is a root
  span `worker <loop>` (registry reconcile, exceptions, digest, remediation reconcile, snapshots, risk, usage, image
  sync, enrichment — correlation already was), the every-few-seconds housekeeping (sweeper, gauges, platform
  heartbeat, the policy_eval queue query) is suppressed, and the sweeper emits a `worker sweep` span only when it
  requeued, failed or marked something offline.
- `span-budget.mjs`: 8 `--wait`-style polls (half with the CLI's unsampled header, half with none) must add 0 spans;
  every root span in both processes must be a request, a `worker <loop>` or a pipeline — the orphan query failed it
  before the fix; the stray check now matches this pipeline's job ids only (a development database's stale jobs no
  longer trip it).

### Observability drop 1 fix-up 2: claim polls leave no trace, every job's claim / start / complete in the pipeline trace, `make kind-jaeger` writes the values file

- Verified on kind (rc.17): the pipeline trace is 42 spans, the root under `matelot-pipeline`. Left over: every
  runner claim poll was a root trace of its own (67 spans, eight identical traces in 15 minutes with no job), and in
  one trace four of six jobs had their `job <kind>`, `/start` and `/complete` spans outside the pipeline's trace.
- Claim polls: the request span of `POST /runner/jobs/claim` is dropped by the trimming rules and the polling loop
  runs with instrumentation suppressed (`suppressTracing`), so an empty poll leaves nothing; a poll that hands out a
  job leaves ONE `claim` span, started from the job's stored traceparent (never the request's context) in the
  pipeline's trace under the job's span, with `matelot.claim.polls`, `matelot.claim.waited_ms`, runner and pool.
- The misparenting could not be reproduced here: with the real runner against the built api and worker (file
  exporter), all six runner jobs had their `job <kind>`, `/start` and `/complete` spans in the pipeline's trace
  (30 spans); the runner sends the job's traceparent on `/start` (its job span is started from `job.traceParent`).
  The span-budget test now pins what rc.17 showed broken: for every job of the security template its `job <kind>`
  span, exactly one `claim` under it, `/start` and `/complete` in the pipeline's trace and none in another, and six
  empty polls adding zero spans — if it recurs on rc.18, the file exporter (`OTEL_TRACES_EXPORTER=file`) on the
  api pod gives the span-level evidence. Skipped jobs (an earlier stage failed) now get a span too, so the trace shows
  every job of the template.
- `make kind-jaeger TENANT=<slug>` writes `observability.otlp.endpoint` into `deploy/cells/<slug>.values.yaml`
  (`scripts/lib/values-observability.py`, standard library, replaces or appends the `observability:` block; tested)
  and runs `cell-provision.sh apply`, so the setting survives upgrades like every other cell setting; a cell without
  a values file (`make deploy`) is upgraded in place with `--reuse-values` and told so. The cell template carries the
  block.

### Observability drop 1 fix-up: the pipeline trace trimmed from 1 824 spans to a budget of 150; pipeline spans under one service

- Verified on kind (rc.16): one trace per pipeline across api / runner / worker, metrics on all three — and 1 824
  spans in the trace, most of them Redis commands of the rate limiter and BullMQ housekeeping (`incr`, `multi`,
  `pexpire`, sub-millisecond), `pg-pool.connect`, and one server span with children per runner `/logs` batch.
- `telemetry/trim.ts`, a span processor applied when a span ends: ioredis housekeeping (`rl:` / `bull:` keys,
  `multi` / `exec` / `pexpire` / `evalsha`) is dropped whatever its duration, any other Redis command under 5 ms too;
  `pg-pool.connect` / `pg.connect` always, `pg.query:*` under 5 ms — slow queries and commands stay. Dropped spans
  are leaves, nothing is orphaned (`trim.spec.ts`).
- The runner sends its `/logs` batches with the sampled flag off: same trace id, no server span at the cell; each
  batch is an event `logs shipped {lines, seq}` on the job span (runner `telemetry.test.ts` checks the header).
- The root span was attributed to whichever process finished the pipeline (the worker, after the gate — which is why
  a search under service `matelot-api` found nothing). Pipeline-level spans (`pipeline <name>`, `job <kind>`) now
  come from a second tracer provider with service **`matelot-pipeline`** (attribute `matelot.emitted_by`), the same
  trimming-free export; the Jaeger recipe in docs and `make kind-jaeger` say so.
- `apps/api/test/span-budget.mjs`, run by CI's api job after the build (a Redis service was added): the built api and
  worker with the tracing preload and `OTEL_TRACES_EXPORTER=file` (new), a security pipeline, a fake runner that
  behaves like the real one; fails above 150 spans, on any `/logs` span, on a root not under `matelot-pipeline`,
  on fewer than 7 job spans, on a surviving pool checkout or sub-5 ms Redis span. Today: 28 spans from the cell
  (the real runner adds its own ~35).

### Observability drop 1 — instrumentation: OTLP traces (one per pipeline), Prometheus metrics with exemplars, JSON logs with trace ids (migration 0049, runner 0.3.3)

- **Traces.** `apps/api/src/telemetry/tracing.ts`, preloaded with `node -r ./dist/telemetry/tracing.js` by the api and
  worker images, Compose and `pnpm start`: the OpenTelemetry SDK with the `http`, `express` (route template only),
  `pg`, `ioredis` and `undici` instrumentations. Off is a no-op (one env read, no SDK module loaded) until
  `OTEL_EXPORTER_OTLP_ENDPOINT` is set or `MATELOT_TRACING_ENABLED=true`; export is asynchronous with a bounded queue
  (2048 spans), an unreachable collector costs dropped spans and one warning, never a slow request or a failed
  `/health/live`; SIGTERM and Nest's shutdown flush with a 5 s cap. Protocols `http/protobuf` (default), `grpc`,
  `http/json`; sampler from `OTEL_TRACES_SAMPLER`; probes, `/metrics` and runner heartbeats are never traced.
- **One trace per pipeline.** Ids are fixed at creation and stored on the rows (`pipelines.trace_parent`,
  `jobs.trace_parent`); the claim response hands the runner its job's traceparent; the runner's `job run <kind>` span
  (phases `checkout`, `tool syft|trivy|semgrep`, `upload sbom`, `upload findings`, `correlate`) goes under it and
  every call back carries the `traceparent` header, so the API side of a job joins the trace; the worker's gate
  evaluation runs under the `policy_eval` job's span; BullMQ job data carries the enqueuer's traceparent. The
  pipeline's root span and each job's span (start = created, events `claimed` / `started`, kind, status, exit code,
  runner) are emitted at their terminal status with the stored ids by whichever process finished them — nothing in
  memory across requests or replicas (`PinnedIdGenerator`). Verified against a real Jaeger 2.22: a security pipeline
  (checkout, syft, trivy ×2, semgrep, gate) is one trace across api, runner and worker — and the trace already
  showed something the logs never did: `semgrep --version` taking 105 s in a sandbox before the scan started.
- **Metrics.** One meter (`telemetry/metrics.ts`) with explicit buckets through Views (http 5 ms–10 s, pipeline jobs
  1 s–30 min, correlation 100 ms–5 min), served on port 9464 (`MATELOT_METRICS_PORT`, never on the ingress) by our own
  OpenMetrics serializer (`telemetry/exposition.ts`) because the SDK's Prometheus exporter renders no **trace
  exemplars**: a scraper accepting OpenMetrics gets `# {trace_id,span_id} value ts` per bucket, pipeline histograms
  pointing at the pipeline's trace — Grafana jumps from a slow p95 to the exact trace. `exposition.spec.ts` pins the
  format (names, `_total`, unit suffixes, buckets, `matelot_build_info` = 1, every label in `ALLOWED_LABELS` —
  an instrument given an id or a name as a label throws). The table of docs/observability.md is implemented:
  http RED by route template, pool connections, BullMQ and pipeline queue depth / age, pipeline jobs and durations
  (+ queue wait), pipelines, runners online / busy / **`matelot_runner_last_seen_timestamp_seconds{pool}`** (so
  `NoRunnerOnline` is an expression on the scrape), claims, correlation duration, open findings by severity and
  kind, gate evaluations, integration sync failures, webhook lag, `build_info`; gauges that need a query are
  refreshed by the worker on a timer (`WorkerGauges`), never on scrape, and their absent series vanish. Optional
  OTLP push with `OTEL_METRICS_EXPORTER=prometheus,otlp`. The runner serves its own page (`RUNNER_METRICS_PORT`):
  job durations with exemplars, jobs by status, busy, `build_info`.
- **Logs.** One line shape for api, worker and runner (`telemetry/log-schema.ts`, the runner's `JsonLogger`):
  `time, level, component, cell, msg, context, trace_id, span_id, request_id, …`; `LOG_LEVEL=info,jobs=debug` per
  module; one redaction list applied at any depth, with a test that logs every known secret key nested three levels
  and fails if a value survives. The runner's `console.*` is gone.
- **Delivery.** Env in `env.ts`, the api ConfigMap and `compose-init` (`MATELOT_OTLP_*` in `.env`); chart values
  `observability.{metrics,otlp,environment}` — metrics ports on api / worker / managed runners, a NetworkPolicy
  admitting scrapers from `metrics.scrapeFromNamespaces`, `OTEL_*` on every component once `otlp.endpoint` is set
  (headers in a Secret); chart-test renders defaults / otlp / metrics-off. `make kind-jaeger TENANT=acme` puts a
  Jaeger all-in-one on kind and points the cell at it. `/api/v1/version` carries `commit` and `builtAt` (image
  build arguments from the release workflow). The runner ships no dependency: its `telemetry.ts` (OTLP/HTTP JSON,
  bounded batching, exemplars, redaction) is 300 lines of its own, tested with `node --test`.
- Not in this drop (drop 2 onwards): ServiceMonitors / PrometheusRule / dashboards, the Compose observability
  profile, backup gauges, OTLP log export, Settings → Observability.

### Design: observability milestone (M14) — `docs/observability.md`, ADR 0004

- The design for platform self-monitoring, OpenTelemetry-first and on the customer's stack: what every process
  emits (OTLP traces, Prometheus metrics on port 9464, JSON logs with `trace_id`), one trace per pipeline carried
  through the runner protocol, the metric table with its cardinality rules, the `OTEL_*` / `MATELOT_*` configuration,
  the Helm `observability.*` block (ServiceMonitors, PrometheusRule, dashboards ConfigMaps — all off by default) and
  the Compose `observability` profile, the four dashboards and twelve alerts, Settings → Observability and the
  `doctor` section, and the four drops with their acceptance. No code in this drop.

### Fix: `apply` on an existing cell failed its own server-side dry run ("Job globex-realm-sync … field is immutable")

- The pre-upgrade `kubectl apply --dry-run=server` included the `realm-sync` hook Job, which exists from the previous
  run until helm deletes and recreates it (`hook-delete-policy: before-hook-creation`); a Job's `spec.template` is
  immutable, so the API server rejected the dry run on every upgrade of every cell, while a fresh install (CI's kind
  dry-run) passed. The rendered chart is now split (`scripts/lib/split-hooks.py`, standard library only): resources
  without a `helm.sh/hook` annotation go through `apply --dry-run=server` as before, hooks through
  `kubectl create --dry-run=server` under a unique name (`<name>-dryrun-<time>`), which validates them without
  touching the existing Job (`dry_run_rendered` in cell-provision.sh).
- `cell-provision.test.sh` covers the upgrade case with a fake API server that rejects an apply of an existing Job and
  accepts a create under a new name: the raw render fails, `dry_run_rendered` passes over the existing Job and on a
  fresh namespace, an invalid non-hook resource still fails, the splitter leaves no hook among the resources to apply.
  CI's kind step does the real thing: the four configurations dry-run on the empty namespace, then the default render
  is created for real (hook Job included) and all four are dry-run again — the same filter, so an upgrade-only
  regression cannot pass CI again.

### Fix: the Helm chart mounted the login theme one level too high — Keycloak fell back to the stock theme

- The theme ConfigMap was mounted at `/opt/keycloak/themes/matelot` with the items named relative to `login/`, so the
  pod held `themes/matelot/theme.properties` while Keycloak resolves `themes/matelot/login/theme.properties`: one log
  line (`Failed to find LOGIN theme matelot, using built-in themes`), the stock page, HTTP 200. The ConfigMap keys and
  volume items now carry the `login/` prefix (`login__theme.properties` → `login/theme.properties` under the same
  mount); rc.14 is harmless but unbranded, this is in the next release. Verified by projecting the rendered ConfigMap
  through the rendered volume items exactly as kubelet does onto a real Keycloak 26.0.8: themed page, assets 200, no
  log line; the rc.14 shape reproduces the report exactly.
- `chart-test` asserts the paths the items RESOLVE to (`mountPath` + item path): every file under
  `files/theme/matelot` lands at `/opt/keycloak/themes/matelot/<path>`, `login/theme.properties` included — not just
  that a mount exists. CI's `chart` job additionally runs `scripts/chart-theme-kind-test.sh`: the chart's theme and
  realm ConfigMaps plus one Keycloak pod with exactly the Deployment's theme volume and mount on the kind cluster, then
  `test -f …/login/theme.properties` in the pod, the sign-in page check, and a grep of the pod log for
  `Failed to find LOGIN theme` (not runnable in the drop's sandbox: no cluster; the pod-building step is).
- Compose assembles the theme correctly (`theme/matelot/login/…`, copied as is to `/opt/keycloak/themes/matelot`; the
  Keycloak service now refuses to start if `login/theme.properties` is not there, compose-init asserts the same, the
  unit test spells the path out). The CI smoke failure had another cause, found by replaying the exact Compose start
  sequence against a real Keycloak: besides the `:80` redirect, the `platform-web` client requires PKCE, so a request
  without `code_challenge` never renders the sign-in page — Keycloak bounces to `redirect_uri` with
  `error=invalid_request`, and the check read the web app's page. `login-page-check.sh` now sends a PKCE challenge,
  requires the final URL to be the auth endpoint, and prints requested URL, final URL, status and body on failure;
  `smoke.sh` fails on `Failed to find LOGIN theme` in the Keycloak log before and after the page check and lists
  `/opt/keycloak/themes/matelot` from the container on failure.
- The tab title is server-side: `loginTitle={0} \u00B7 Matelot` in the theme's `messages_en.properties`, rendered by
  Keycloak's own template; nothing in JavaScript.

### Fix: the sign-in page check in the Compose smoke test; verified against a real Keycloak 26

- The smoke step asked Keycloak for the sign-in page with `redirect_uri=http://localhost:80/` while the client
  registers `http://localhost/*` — Keycloak answers 400 for an unregistered redirect — and its one-line assertion
  printed an empty title with nothing else to go on. The check is now `deploy/compose/login-page-check.sh <base>`:
  it drops a default `:80` / `:443` from the base, follows redirects, and on any failure prints the requested URL,
  the final URL, the HTTP status and the first 300 bytes of the body; `smoke.sh` calls it through Caddy and dumps
  the Keycloak log when it fails.
- The title is server-side: the theme's `messages_en.properties` sets `loginTitle={0} \u00B7 Matelot` (escaped
  middle dot, so every properties reader agrees) and Keycloak's template renders it — no script involved
  (`matelot.js` only sets the card heading and the icon links). Checked here against **Keycloak 26.0.8** from the
  GitHub release tarball, in dev mode and in production mode (`start`, theme cache on), with a realm importing
  `loginTheme=matelot`: tab title "Globex Corporation · Matelot", heading "Sign in to Globex Corporation", every
  theme asset 200, screenshots in light and dark. The full Compose smoke (Caddy, the images) cannot run in this
  sandbox (no registry access); the check itself is what CI runs.
- `apply`'s server-side validation uses server-side apply (`--server-side --dry-run=server --force-conflicts` with
  its own field manager): no more kubectl warning about the hook Job's missing last-applied-configuration; the CI
  kind dry-run does the same.

### Fix: Helm upgrade rejected the theme ConfigMap (favicon.svg in both data and binaryData); API-server validation before every apply

- `helm upgrade` on kind failed with `data[resources__img__favicon.svg]: Invalid value: duplicate of key present in
  binaryData`: the theme ConfigMap put every `img/*` file in `binaryData` and every non-png/ico file in `data`, so
  the new favicon.svg landed in both — which `helm template` renders happily and only the API server rejects. One rule
  now: the file **extension** decides (png / ico / jpg / gif / woff / ttf → `binaryData`, everything else → `data`).
- **Guards for what `helm template` cannot see.** `chart-test.sh` asserts, for every rendered ConfigMap and Secret, that
  no key is in both `data` and `binaryData`, every key is `[-._a-zA-Z0-9]+` and ≤ 253 characters, and no resource is
  rendered twice. The CI `chart` job now starts a kind cluster (helm/kind-action, about 40 s) and runs
  `kubectl apply --dry-run=server` on the rendered chart in four configurations (defaults, TLS, branded theme,
  backups), so API-server validation runs before a tag.
- **`cell-provision.sh apply`** validates the rendered chart with `kubectl apply --dry-run=server` against the cell's
  own cluster before touching an existing release — nothing is changed when the server rejects it — and handles a
  release an earlier apply left behind: `failed` with a good revision is upgraded over (globex's state on kind),
  `pending-*` (an interrupted helm) is rolled back to the last good revision first, and `failed` with no revision ever
  deployed stops with what to do (helm cannot upgrade that). Tested with a fake helm in `cell-provision.test.sh`.

### Favicon designed for small sizes; one icon set for the app and the sign-in page, generated from the SVG

- The tab icon was the full captain's cap scaled to 16 px — a shapeless light blob on a dark tab bar. New mark:
  the anchor alone, two flat colours on a filled rounded square (`apps/web/public/favicon.svg`, with a
  `prefers-color-scheme` rule: navy square / sky anchor on light tab bars, sky square / white anchor on dark). Strokes
  3 px at 32 px; the 16 px frame is rendered with thicker strokes and without the fluke tips, not resampled.
- Shipped as `favicon.svg` (first in `index.html`), `favicon.ico` with 16 / 32 / 48 px frames each rendered at its own
  size, `favicon-32.png`, `apple-touch-icon.png` (180, the full cap), `icon-192.png` / `icon-512.png` with
  `manifest.webmanifest` (full cap). `favicon.png` is gone.
- **`tools/icons/build.mjs`** (`pnpm icons:build`, workspace package `@secops/icons`, sharp) regenerates every size from
  `favicon.svg` / `logo-512.png` into `apps/web/public` and the Keycloak login theme (chart source and compose copy);
  `--check` (CI, `pnpm --filter @secops/icons test`) fails when a committed icon differs from what the sources render
  (pixel comparison). `chart-test.sh` fails when the theme's favicon / apple-touch-icon differ from `apps/web/public`.
- The login theme links the same set: its script puts `favicon.svg` before the stock `favicon.ico` link and adds the
  apple-touch-icon; the smoke test fetches favicon.svg, favicon.ico and favicon-32.png from the sign-in page (200).
- `docs/branding.md` shows the rendered 16 px and 32 px frames (light and dark) — `docs/branding/favicon-review.png`,
  written by the build — and the rules the mark follows.

### Branded sign-in page: the `matelot` Keycloak login theme (Helm and Compose)

- The sign-in pages rendered the stock `keycloak.v2` theme: Keycloak's favicon, "Sign in to <realm>" as tab title, no
  branding. The cell now ships a **`matelot` login theme** (`deploy/helm/secops-cell/files/theme`, copied to
  `deploy/compose/init/theme`): it extends `keycloak.v2` and overrides no template — only `theme.properties`
  (stylesheets + one script), a messages file, CSS, a small script and images — so OTP, password reset, consent and
  error pages keep Keycloak's layout and a Keycloak upgrade cannot break it. Branding: the web app's favicon
  (`favicon.ico` built from `apps/web/public/favicon.png`, plus the apple-touch-icon), the product logo above the
  form, the tenant name in the brand band and as the sign-in heading ("Sign in to Globex Corporation" — set by the
  theme's script on the sign-in page, English only; other pages and locales keep Keycloak's wording), the tab title
  "<tenant> · Matelot", the app's palette in light and dark (`prefers-color-scheme`) through PatternFly variables, and
  the Outfit font (Google Fonts; system font offline).
- **Per cell:** `keycloak.theme.logo`, `keycloak.theme.primaryColor` (`primaryColorHover`) render `css/cell.css`;
  `keycloak.theme.enabled: false` is the stock look. Compose: `MATELOT_THEME_LOGO`, `MATELOT_THEME_PRIMARY_COLOR`.
  docs/cell-provisioning.md §Branding the sign-in page.
- **Helm:** one ConfigMap `<release>-keycloak-theme` holds every theme file (images as `binaryData`; keys are the
  paths with `/` → `__`, mapped back by the volume) mounted at `/opt/keycloak/themes/matelot`; its checksum is on the
  Keycloak pod, so a theme change restarts Keycloak. **Compose:** `compose-init` assembles the theme plus `cell.css`
  into the config volume and the keycloak service copies it into `/opt/keycloak/themes` at start.
- **realm-sync** applies `loginTheme` (and `accountTheme` / `emailTheme` when a realm.json carries them) on every run,
  like the URLs. The realm **display name** is now the plain tenant name (no "Security Platform" / "· Matelot"
  suffix) with `displayNameHtml` the same; realm-sync migrates the old templated forms once and keeps a display name
  typed by hand.
- Tests: `realm-sync.test.js` (themes applied, stale names migrated, hand-typed names kept, pure `realmSettingsPatch`
  cases); `compose-init.test.sh` (theme assembled, cell.css empty by default and rendered from the variables);
  `chart-test.sh` (every theme file in the ConfigMap, images byte-identical, the volume maps every key, mount path,
  checksum, realm selects the theme, `theme.enabled=false` is stock, compose copy identical); the Compose smoke test
  loads the realm's sign-in page and checks the "· Matelot" title and that favicon.ico, apple-touch-icon.png,
  logo.png, matelot.css, cell.css and matelot.js are served (200). The web app's jsdom tests are untouched.
- Not verified here: the page in a real Keycloak 26 (the chart render was checked with a stand-in renderer and the
  CI chart job runs the real helm; the smoke step runs in CI's `compose` job).

### Fix: cell-provision `checks` declared the cell unhealthy in the endpoint-switch window after a rollout

- Right after "all workloads rolled out", the in-cluster probe (`GET http://<release>-api/api/v1/health/ready` from a
  curl pod) made one request, hit the moment the Service endpoints switched to the new pod, printed "→ no answer:"
  with nothing after it and exited 1 — while `matelot doctor` through the ingress answered seconds later. The probe
  pod now retries with backoff (2, 4, 8, 10, 10 … s) for up to `READY_TIMEOUT` seconds (default 60), the api line
  says how long readiness took ("→ 200 (ready in 1s)", or "→ 200 after 9s and 3 attempts (the first 2 got no answer:
  the Service endpoints were still switching)" with the attempts listed), and only after the retries is the cell
  unhealthy — then with the last HTTP status and the start of the error / body, never an empty "no answer:".
  `cell-provision.test.sh` runs the probe loop with a fake curl (refuses twice then 200; immediate 200; never) and
  checks the report lines.

### Fix: service summary counted no vulnerabilities for an undeployed service; SAST fingerprints; CLI times with offset

- **`GET /services/:id/summary` reported "0 open"** next to a gate line saying "1 open critical": it filtered on
  `findings.running`, which is false for every finding of a service that has no deployment yet. It now counts what the
  gate counts — the open findings linked to the newest SBOM, one per (advisory, source package) — and returns that
  SBOM's id. Spec (`service-summary.spec.ts`, database): a service with no deployment, two open findings of which
  one is in the newest SBOM → `open.total = 1`, `kev = 1`.
- **SAST: one finding per issue across runs.** Ingest already matched by fingerprint and closed what a scan no longer
  reports (the spec proves it: three ingests with the same fingerprint → 1 open; a changed fingerprint → 1 open,
  1 fixed). What can vary per run is the fingerprint's path when semgrep prints the checkout under another prefix
  (symlinked temp dir) or relative to the runner's cwd (`../job-abc123/repo/app/run.py`): the per-job workspace then
  lands in the fingerprint. The runner now reduces every form to the repository path (`relativeToRepo`), folds
  whitespace in the matched lines, and a test fixes the fingerprint across five path forms. The summary also lists
  the open code findings **per rule**, and `matelot service show` prints them — "3 code (eval-detected ×3)" is the
  same issue re-opened per run, "3 code (eval-detected, dangerous-eval, …)" is three rules on one line — so the next
  run on kind tells which it was; after it, 1 open and 2 fixed is the expected state.
- **CLI 2.24.1:** timestamps in `service show` and in every table are local time with the UTC offset
  ("2026-10-18 10:52+03:00", "…07:52Z"), never bare UTC that reads as local.

### From the end-to-end pipeline test: connect with a write token, explicit policy rules, service summary, job names, secret detectors

- **`integration:connect` is day-to-day work.** It left the sudo-only set: a developer's / team lead's `write` token
  (or a service account) connects a git host or registry to a project, team or workspace. Creating an
  **organization-wide** connection additionally needs `organization:write` — an owner, sudo or the web session.
  Disconnecting (forgetting credentials), rotating credentials, on-demand sync and deletion stay `integration:write`
  (sudo). The token-scope matrix spec, the consent page, the MCP guidance and docs/roles.md say so.
- **Policy rules are explicit.** `matelot policy create` sends all seven rules: a block rule not asked for is off
  (`--max-severity high --block-kev --action block --enforce` no longer produces a `block_secrets` violation),
  `--honour-decisions` defaults to on; every boolean flag has a `--no-…` form; `policy update` sends only the flags
  given. The API's create fills a missing boolean rule with **off** too (`CREATE_DEFAULTS`); rows stored before keep
  reading missing rules as the old defaults so an existing policy blocks what it blocked. `policies list` /
  `in-force` show the rules in one column ("max high · kev · secrets · sbom").
- **`GET /services/:id/summary`** (`vulnerability:read`): the service with its latest pipeline and jobs, open
  findings by severity (+ KEV, running ones), open code findings by kind and the newest SBOM — one call.
  **CLI 2.24.0:** `matelot service show` reads it and prints five lines (pipeline #, status, ref, jobs with the error
  of a failed one; open findings; code findings; latest SBOM); `--json` for scripts.
- **docs/ci-integration.md:** the pipeline jobs table uses the names the API and CLI report (checkout, sbom,
  dependencies, code, secrets, infrastructure, evaluate) with the job type beside them, and a new section lists what
  the secrets job detects — checked with trivy 0.74.0 (the runner image's version) and the runner's exact command on
  a planted repository: the AWS documentation example pair is on trivy's allow list, the AWS secret key fires only
  with its keyword on the line, `ghp_` needs exactly 36 characters, and `test(s)/`, `example(s)/`, `vendor/`,
  `node_modules/` and `*.md` are skipped. With random-looking values all three planted secrets are reported.

### Fix: cell-provision `apply` waited for "N pods ready", not for the rollout

- One second after `helm upgrade` returned the wait printed "all workloads ready (pods 7/8 ready) · waiting:
  globex-api-… (Running 0/1)" and `checks` ran against the old API pod. `cellwait.py` tested `readyReplicas ≥ n` and
  `updatedReplicas ≥ n` separately: during a rolling update the **old** pod is the ready one and the **new** pod the
  updated one, so both passed — a broken new image would have passed the checks. "Done" is now what
  `kubectl rollout status` means, per Deployment / StatefulSet: `observedGeneration ≥ generation`, `updatedReplicas`,
  `readyReplicas` and `availableReplicas` all ≥ spec, `unavailableReplicas == 0`, and no surplus replica
  (`status.replicas ≤ updated` — the old pod is gone); StatefulSets also need `currentRevision == updateRevision`.
  Terminating pods (deletionTimestamp) no longer count. The summary reads "N/M workloads rolled out, pods a/b ready",
  and a workload whose pods all look fine but is not rolled out says why ("controller has not observed the new
  generation yet", "1 old replica(s) still terminating", "revision … rolling out").
- Tests (`cellwait_test.py`): mid-rollout (replicas 2 / updated 1 / ready 1 → not done), generation not observed
  yet → not done, new pod ready but old one terminating → not done, StatefulSet update revision not current → not done.

### Header pickers are our own popover, not native selects; Team level in the switcher

- The Workspace / Team / Project / Service pills (and Organization, Refresh) open a TailAdmin-style panel under the
  pill — same surface, border, radius and shadow as the user menu, dark-mode aware — instead of a native `<select>`,
  which Chrome painted with the OS look (white list, blue highlight) over the dark theme. Items show the name
  (ellipsis, full name on hover) and the slug underneath; the current one carries a check; "All workspaces / All
  projects" (or "Whole workspace / Whole team" inside a scope) sits first above a divider; a type-to-filter field
  appears from 7 items. Keyboard: arrows, Home / End, Enter / Space, Escape (focus returns to the pill), Tab; click
  outside closes. ARIA: `combobox` + `aria-expanded` / `aria-activedescendant`, `listbox` / `option` /
  `aria-selected`. One component, `LocationPicker` in `platform/header/ContextSwitcher.tsx`, for every header picker;
  no native select is left in the header (the render test asserts it).
- **Team in the switcher** at every level: Workspace › Team › Project (› Service inside a project), each list scoped
  to its parent — teams of the workspace, projects of the team, or of the workspace when no team is chosen.
- Native controls that remain on pages (list filters, date fields, scrollbars) follow the theme through
  `color-scheme: dark` on the dark root, so they no longer render with the OS light look.
- Tests: the render test opens the picker, checks roles, the divider, the check mark, Escape and focus return, a
  keyboard pick (ArrowDown → End → Enter navigates), the team list scoped to the workspace, a mouse pick into the team,
  and click-outside. Checked in Chromium in light and dark mode at 1280 / 1440 px with the filter field.

### Navigation: you always know where you are (breadcrumb, scope card, titles, location switcher, team pages)

- **Breadcrumb on every page**, full path and clickable: Organization › Workspace › Team › Project › (Service) ›
  Page, e.g. "Globex › Platform › Payments team › checkout-api › Members"; each segment opens that scope's overview,
  detail pages add their list ("… › Pipelines › Pipeline"). Middle segments end in an ellipsis with the full name on
  hover; on a phone the trail wraps.
- **Headings and tab titles name the scope:** "Members — checkout-api (project)" and "Members · checkout-api · Globex".
  The old per-page headings and the workspace / project header blocks are gone (one source: `useScopeLocation` in
  `platform/navigation/scope.tsx`).
- **Sidebar scope card** (initial, name, "Organization" / "Workspace" / "Team" / "Project", criticality on projects)
  with "← Back to <parent>" above it; the menu below is that scope's menu.
- **Header location switcher** shows where you are — "Workspace: Platform ▾ › Team: Payments team ▾ › Project: … ▾",
  inside a project "Workspace ▾ › Project ▾ › Service ▾" — as pills that navigate (the URL changes); "All workspaces /
  All projects" only on organization-wide pages. Visibly different from the filter dropdowns on list pages.
- **Teams are a level of their own:** Workspace → Teams (list, New team), team pages Overview (its projects, New
  project), Members and Settings (rename, archive) under `/workspaces/:id/teams/:teamId`, in the breadcrumb and the
  switcher. "Teams & projects" is now "Projects".
- **First run:** creating a workspace lands inside it with "Next step: Create a team"; creating a team lands inside it
  with "Next step: Create the first project of this team"; creating a project opens it.
- **Long names:** the product name in the sidebar ("Globex Corporation Security Platform") ends in an ellipsis on
  one line with the full name on hover (it ran off the sidebar edge); the same for the scope card, breadcrumb and
  switcher. The header no longer pushes the page wider than the window at 1280 px (the e-mail next to the avatar and
  the "Idle" label show from 2xl); members toolbar fields sit side by side on desktop and stack on phones.
- Tests: the render test checks breadcrumb (labels, links, current page), sidebar card and back link, heading, tab
  title and header pills on organization, workspace, team, project and service/detail pages, that the switcher
  navigates, and the product-name ellipsis; the members flow test covers workspace → team → project creation landing
  inside each new scope. Also checked in Chromium at 375, 1280, 1440 and 1650 px with long names.
- **chart-test:** `Deployment/acme-registry` is off the TLS-switch must-not-roll list again (its token realm URL carries
  the scheme, so it legitimately rolls on `tls false → true`); the last two drops had reverted this and CI `chart` failed.
- **cell-provision `checks`:** restarts of pods that are terminating or belong to a ReplicaSet the rollout scaled to 0
  (the old api pod after an upgrade) are no longer listed; the line says how many were skipped. Tested with sample
  pod data in `cell-provision.test.sh`.
- **CLI 2.23.2 — `doctor` always prints the version line.** The "`doctor | grep version` printed nothing" report was
  a shell that had lost `NODE_EXTRA_CA_CERTS` (kind's local CA): the api check failed and the version line was never
  reached. Now an unreachable API still prints `--  version  skipped: api unreachable (…)`, and a certificate Node
  does not trust (`DEPTH_ZERO_SELF_SIGNED_CERT`, `SELF_SIGNED_CERT_IN_CHAIN`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`,
  `ERR_TLS_*`, …) says so on both lines: "Node does not read the OS trust store: for a private CA set
  NODE_EXTRA_CA_CERTS=/path/to/ca.crt (the kind recipe: ~/matelot-dev-ca.crt)". `matelot login` and every API call
  give the same hint. Tested against an HTTPS stub signed by a throw-away CA (openssl): fails with the hint, green
  with `NODE_EXTRA_CA_CERTS` pointing at that CA. Kept from 2.23.1: the CLI no longer calls `process.exit()` while
  output may still be queued (stdout to a pipe is asynchronous on macOS and Windows) — gate / verify exit codes use
  `process.exitCode` and the error path flushes first.

### Members at every level, service accounts, user administration; dialog headers and name fallbacks

- **Members** (Organization, Workspace, Team — new *Team members* page —, Project): direct members plus, read-only,
  everyone inherited from above with a link to where it is granted; columns member, role, source, granted by / at,
  expires, actions; filter and direct / inherited switch; Edit (role, expiry, reason), Remove, Leave.
- **Roles per level** in GitLab order with a one-line description and the closest GitLab role; only the roles relevant
  to the level are offered (`GET /members/roles`). docs/roles.md has the GitLab mapping table and the rules.
- **Rules in the API:** only `membership:write` holders manage members, and a `write` token cannot (sudo or web);
  nobody grants, changes or removes a role above their own at that scope; a direct role must raise inherited access,
  never lower it; one direct membership per person per scope; optional expiry (expired memberships grant nothing);
  the last organization admin is protected. All audited.
- **Invite members:** search people, paste several e-mail addresses (bulk), role + optional expiry. Unknown addresses
  get a Keycloak account and a one-time setup link (`/invite/<token>`, 7 days), e-mailed with SMTP, otherwise shown
  once to copy; with an external IdP the role applies at first sign-in.
- **Administration → Users** (cell admins and root-organization admins): create (temporary password or setup link),
  disable / enable (sessions ended, tokens refused), reset password, delete (memberships and tokens go; sole org admin
  protected), a person's roles across scopes and their tokens.
- **Service accounts:** bot users owned by a scope (no password, no browser login, *bot* badge, roles only at the
  owner scope and below) with tokens — name, read / write, expiry up to `SERVICE_ACCOUNT_TOKEN_MAX_DAYS` (365), last
  use, rotate, revoke, shown once — and *New access token* (GitLab project access token: bot + role + token in one
  step). docs/access-tokens.md explains service accounts vs CI tokens.
- **Capabilities** for the M13 tier mapping, all on today: `inherited_members`, `member_expiry`, `bulk_invite`,
  `invite_links`, `user_admin`, `service_accounts`, `scope_access_tokens` (`custom_roles` reserved);
  `MATELOT_FEATURES_DISABLED` turns one off; listed in `GET /meta`.
- **CLI 2.23.0:** `matelot members list|roles|candidates|add|update|remove --scope projects/ID` (or `org`),
  `matelot users list|show|create|disable|enable|reset-password|delete`, `matelot service-accounts …` (tokens
  create / rotate / revoke), `matelot access-token create`, `matelot invite show|accept --link …` (no login needed).
- Migration `0048_members_service_accounts` (users.kind / owner scope, memberships.expires_at, user_invites).
  The chart and Compose give the API the bundled Keycloak's admin URL and credentials.
- Compose smoke: a service account on the project reads it with its token; after revocation the token gets 401.
- **UI fixes from the review:** every dialog (30, including the new ones) now has a header row with the title, description and the close
  button aligned — the × no longer overlaps titles or the first field at any width; the old right-padding hacks are
  gone; the close button has an accessible label and dialogs are announced with their title. Names: a user without
  a name shows the e-mail and initials from its local part (no more "test test" / "TT"); the user menu no longer
  repeats the e-mail and truncates long names; the API no longer stores an e-mail as display name (cleared on next
  login); Keycloak no longer requires first / last name (realm-sync relaxes the user profile — that requirement
  produced the placeholder names); seeded and invited users get names only from a `first.last` address.
- Not verified here: the Keycloak admin API calls against a live Keycloak, SMTP delivery of setup links, the new
  Compose smoke step and the Helm wiring on kind (unit tests use a fake Keycloak).

### Helm: the first administrators are seeded; TLS/domain changes never restart the database; realm-sync keeps its trace
- **Seeded administrators (parity with Compose).** The realm-sync hook now also creates every `tenant.adminEmails` address that has no user in the realm — username = e-mail, enabled, verified, with `SEED_ADMIN_PASSWORD` from the Secret `<release>-keycloak` (`keycloak.seedAdminPassword`, else generated once and kept across upgrades via `lookup`) as a **temporary** password: the first login asks for a new one. Existing users are never modified (not their password, not their flags); `keycloak.seedAdmins: false` turns it off. NOTES.txt and `cell-provision.sh apply` print how to read it (`kubectl -n <ns> get secret <release>-keycloak -o jsonpath='{.data.SEED_ADMIN_PASSWORD}' | base64 -d`). Compose passes its `MATELOT_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` through the same path (the realm import already created the user; a later e-mail change gets seeded). Tests: realm-sync.test.js creates a missing user with the temporary credential, leaves an existing (disabled) one byte-identical, never PUTs a user, creates nothing on a second run; chart-test asserts `SEED_USERS` = `tenant.adminEmails`, the secretKeyRef, the Secret key, and that `seedAdmins=false` renders neither; the keycloak Secret is in the install == upgrade identity check. Docs: install.md § B4, cell-provisioning.md § 4/5, the public helm-charts README.
- **Restarts after the TLS upgrade.** The pod templates of postgres, redis, the runners and the backup CronJob carry nothing derived from the ingress or the domain (no checksum annotation, stable labels), so an upgrade cannot recreate them; chart-test now proves it: a `tls=false → true` render and a domain change must leave those templates byte-identical (api/worker/web/keycloak roll, and on the TLS switch the registry too: its token realm URL carries the scheme). What `checks` showed is the container's `restartCount` inside the same pod — a crash or probe kill that survives the upgrade in the counter, most likely from the first start. `checks` now prints when and why: `restarts: acme-postgres-0 1 (last: Error at …; pod started …)`, so a count that predates the upgrade is not read as caused by it; if the pod start time is older than the upgrade, the restart was not the upgrade's.
- **realm-sync trace.** `hook-delete-policy: before-hook-creation` only: the last run's Job stays for `kubectl -n <ns> logs job/<release>-realm-sync` (deleted right before the next run), and `apply` prints its summary line (`realm-sync: realm platform synced: client platform-web: redirectUris → …; user ciso@… created …`).
- Not verifiable here: the seeded login on kind (install → read the Secret → first login forces a password change) is the next live check.

### Fix: realm redirect URIs after an upgrade (Helm); preflight read a YAML comment as the issuer; kind recipe for the CLI and Windows
- **Keycloak realm sync (chart):** `start --import-realm` is IGNORE_EXISTING, so the tls=false → true upgrade left the `platform-web` client with http redirect URIs ("Invalid parameter: redirect_uri"). New `files/realm-sync.js` applies the rendered realm's URL-shaped settings through the admin API — realm `sslRequired`; per client (by clientId) `redirectUris`, `webOrigins`, `rootUrl`, `baseUrl`, `adminUrl`, the post-logout attribute — and nothing else: users, roles, mappers, hand-made attributes stay; missing clients are reported, not created; idempotent. The chart runs it as the post-install/post-upgrade hook Job `<release>-realm-sync` (api image, non-root, waits for Keycloak and for the realm to exist, 600 s deadline); the script ships in the realm ConfigMap, and Keycloak now mounts only `realm.json` from it (its import directory must hold JSON only). Compose is equivalent: a one-shot `realm-sync` service runs the same script (`init/realm-sync.js`, parity checked by chart-test) on every `up` after Keycloak is healthy, `welcome` waits for it, and `compose-init.sh realm-update` delegates to it.
- Tests: `files/realm-sync.test.js` (layout CI job) — a fake Keycloak admin API imported with http URIs, the rendered realm says https: after the sync the client has the https URIs and `sslRequired: external`, users/roles/groups are never called, mappers and hand-made attributes survive, a second run changes nothing, a wrong password fails before touching anything. chart-test asserts the hook (annotations, command, realm-only mount) and the rendering of both sides of the scenario (http realm with tls=false, https realm with tls=true); compose-init.test.sh covers the `realm-update` wiring; smoke.sh checks `realm-sync` ran.
- **Preflight:** `cell-provision.sh` read the issuer with sed, inline comment included (`selfsigned   # letsencrypt in production…` → "ClusterIssuer NOT found"). Values are now read as YAML (`values_get`: PyYAML when installed, else a small indentation parser; quotes and comments handled) for className, tls, the issuer and the domain. `scripts/cell-provision.test.sh` (layout CI job) runs `new` against a fake kubectl (kind context → `selfsigned`, elsewhere → `letsencrypt`, `--issuer` wins) and reads the generated file with PyYAML and with the fallback parser.
- **Docs / kind-up.sh:** the kind recipe now covers the CLI (`NODE_EXTRA_CA_CERTS=~/matelot-dev-ca.crt matelot login …`; Node ignores the OS store), Docker's trust for the registry host, the Windows CA import (`certutil -addstore -user Root`, from WSL via `/mnt/c/Windows/System32/certutil.exe`), and that the hosts entry belongs in the hosts file of the machine the browser runs on (Windows `drivers\etc\hosts` on WSL, not only `/etc/hosts`). cell-provisioning.md, the public helm-charts README and install.md describe the realm sync.
- Not verifiable here (no kind/helm/Docker): the hook's live run on kind — the `install http → upgrade https → login` scenario — is the next thing to try on your machine.

### Fix: browser login needs HTTPS on any hostname but localhost (Helm); kind gets a local CA
- Finding on kind with `ingress.tls=false` and `acme.platform.local`: Keycloak's login page fails with "Crypto.subtle is available only in secure contexts (HTTPS)" — browsers treat only `https://` and `localhost` as secure contexts. Not a chart bug, but the chart now says so: NOTES.txt prints a warning when `ingress.tls` is false and the hostname is not localhost / `*.localhost` / 127.0.0.1 (`cell.insecureContext` helper), and the same text goes on the app Ingress as the annotation `matelot.cloud/insecure-context` (what `helm template` and chart-test can see). chart-test renders `insecure-hostname`, `plain-localhost` and `tls` and asserts the warning appears exactly in the first.
- `cell-provision.sh` preflight warns with the same message when `tls` is not true on a non-localhost domain; `new` takes `--issuer` and defaults to `selfsigned` when the current context is `kind-secops`, `letsencrypt` otherwise (template placeholder `__ISSUER__`; `tls: true` commented as mandatory).
- `scripts/kind-up.sh` installs cert-manager (`CERT_MANAGER_VERSION`, v1.17.2) and a local CA (`deploy/kind/cert-manager-selfsigned.yaml`: self-signed bootstrap issuer → CA certificate `matelot-dev-ca` → ClusterIssuer `selfsigned`), waits for both, and prints the /etc/hosts line and how to trust the CA. `make deploy` sets `ingress.tls=true` with that issuer, so `make kind-up && make deploy TENANT=acme` and `kind-up.sh && cell-provision.sh new/apply` both give a browser login over HTTPS without Chrome flags.
- Docs: install.md § B requirements, cell-provisioning.md § 1 (+ the kind recipe), the public helm-charts README § Ingress and TLS.
- Not verifiable here (no kind/helm): the chart rendering was checked with the template stand-in; the kind recipe needs a run on your machine.

### Docs: custom domain everywhere; the clone step; image tag spelling
- Every customer-facing link now uses https://matelot.cloud (Compose README and `.env`/`compose.yaml` defaults, `MATELOT_DOCS_URL`, the web app's default `docsUrl`, chart `Chart.yaml`/`values.yaml`, CLI README, the public READMEs/SUPPORT/SECURITY/profile, image labels via `SITE` in release.yml, the website's `content.json` url); the GitHub Pages address keeps serving as a fallback.
- The Compose quick start starts with what a customer actually types: `git clone --depth 1 https://github.com/matelot-cloud/matelot && cd matelot/docker` (docker/README.md, install.md, the public README), and notes that `docker compose up -d` pulls the public ghcr.io images without a login.
- Images carry two tags (`0.1.0-rc.8` and `v0.1.0-rc.8`); `MATELOT_VERSION` and the chart's `image.tag` take the bare version — said in install.md, docker/README.md, the release notes template and release-process.md.

### Fix: release pipeline — worker build hung 3 h 37 min; `npm pack` directory lost on regeneration
- **Timeouts on every job** of every workflow (`timeout-minutes`): images 25 (a multi-arch build not done by then is hung — the arm64 leg under QEMU stalled on `images (worker)` for v0.1.0-rc.7), ci compose 45, the rest 5–25. A hang now fails in minutes.
- **Worker built from the api job:** the worker is the second target of the api Dockerfile, so the `api` matrix leg builds it right after the api image on the same builder (`also: worker`): the shared stages are cache hits instead of a second full QEMU build. All image builds use the GitHub Actions cache (`type=gha`, scope per image; the worker also reads the api scope). Signing/SBOM/digest steps moved to `.github/scripts/sign-image.sh` (shellchecked) so both targets share them; SBOM artifacts are `sbom-<name>.spdx.json`.
- **Re-run safe release:** the `release` job runs when every upstream job succeeded in this *or an earlier attempt* (`if: !cancelled() && needs.*.result == 'success'`) — "Re-run failed jobs" re-runs only the failed image leg and the release — and refuses to publish unless all four image digests are present.
- **`publish-cli.yml`:** `PACK` job env and `mkdir -p "$PACK" && npm pack --pack-destination "$PACK"` (the `mkdir` restored on main in a4069dd is now in the source of the workflow and cannot be dropped silently).
- **Guard:** `scripts/check-workflows.sh` (layout CI job, `make check-layout`) fails on a job without a timeout, a pack step without the mkdir or with a literal `/tmp/pack`, a separate worker leg, an images timeout above 30 min, a release job without the re-run guard or the digest check. docs/release-process.md § Workflow hygiene updated.

### Fix: `registry path` is the full reference — smoke.sh (and two hints) prefixed the host again
- CI's registry step built `localhost:5000/localhost:5000/smoke/platform/payments/api:1` ("invalid reference format"): `matelot registry path --service ID` already prints the pushable reference with the host — that is what CI pipelines use — and smoke.sh added the host once more. Decided once and written down: **`registry path` prints the full reference, host included; use it verbatim** (`docker push "$(matelot registry path --service ID)":<tag>`). smoke.sh does exactly that (and asserts the output starts with the registry host); the `registry login` hint, `registry info`'s "exact reference" line, the API's `pathRule`, cli.md, install.md and ci-integration.md say the same. **CLI 2.22.4.** Test: `registry path` output against a fake cell starts with the host; the info text never contains `localhost:5000/$(matelot registry path`.

### Fix: built-in registry — image sync dialled the public host from inside the api; `registry login` username; the path rule
- **`matelot image sync` → `400 fetch failed`** for an image in the built-in registry: the API opened `http://localhost:5000` — inside the api container that is the api itself. New `REGISTRY_INTERNAL_URL` (`http://registry:5000` from `compose-init.sh`, `http://<release>-registry:5000` in the chart's api ConfigMap) is what the API now dials for the built-in registry (image sync and the catalog reconcile), the same way runners get `registryHostAliases`; the image name keeps the public host (token scope, messages, `docker pull`). `RegistryClient` takes the base URL as an optional parameter.
- Network errors name the target: `cannot reach registry localhost:5000 at http://registry:5000: ECONNREFUSED (connect ECONNREFUSED …)` instead of `fetch failed` — in the 400, in `images list` → `lastError` and in the log. Unit tests for both.
- **CLI 2.22.3:** `matelot registry login` prints `logged in to localhost:5000 as token (personal token)` / `as <key id> (CI token)` plus the push pattern (the username was the CI key id even for personal logins, hence empty). `matelot registry info` is rendered: host, login, `<workspace>/<team>/<project>/<service>:<tag>` and the environment variant, the exact-name command (`matelot registry path --service ID [--env ID]`), and that any other repository name is refused by the registry with `insufficient_scope: authorization failed` (`--json` unchanged; the API's `/registry/info` carries `pathRule` and `pathCommand`). Docs: ci-integration.md (built-in registry), install.md quick start, cli.md.
- **Smoke:** service created → `registry info` → `registry login` with the stored personal login → `docker build` (FROM scratch) and `docker push localhost:5000/<path>:1` → a push to `not-a-service:1` must be refused → the push notification registers the image (polled up to 60 s) → `image sync` reports ≥1 tag → `images list` shows tag `1` and no `lastError`. Not verifiable here (no Docker daemon): the next CI `compose` run is the proof.

### Fix: Compose restore into a fresh cell left Keycloak/API with the wrong Postgres password
- **Scenario (the only one that matters for DR):** `down -v` → `up -d` on a new host → `cell-restore.sh --compose`. The cluster was initialised with the freshly generated `POSTGRES_PASSWORD`; the restore put the archive's secrets back and imported the dumps, but dumps carry no role passwords, so Keycloak and the API read the old password while the `platform` role still had the new one (`FATAL: password authentication failed`, Keycloak restart loop, "dependency failed to start"). The smoke never hit it because it restored straight after `down -v`: `init restore-secrets` ran before the first Postgres start, so the cluster was initialised with the restored password.
- `restore-db.sh` (chart and Compose copies): with `ALIGN_SOCKET` set, it first runs `ALTER ROLE "<POSTGRES_USER>" PASSWORD '<restored>'` over the container's unix socket (trust auth, so the mismatch itself cannot block it; psql variables, so any password quotes safely), then checks the TCP connection with the restored password before touching a database. `compose_restore` sets it (`/var/run/postgresql` in the postgres container); the Helm path is unchanged in behaviour (its runbook restores secrets before `helm install`) but gets the clearer "cannot connect with the restored password" error instead of a `dropdb` failure.
- `compose_restore` now stops api, worker, keycloak, runner, registry **and welcome** before replacing data; counts the registry files restored against the archive (`registry restore incomplete: 1 files in the volume, 2 in the archive` is an error — "0 files" is reported only when the archive had 0); starts the cell and waits up to 300 s for every container to be running and healthy (`compose_wait_healthy`, both `compose ps --format json` shapes), printing `docker compose ps -a` and the last 30 log lines of each unhealthy container and exiting non-zero otherwise; ends with `init show` (URL, admin login, restored password). `--yes`/`-y` documented in the usage line and docs (it existed).
- **smoke.sh reproduces the customer's scenario:** backup → `down -v` → `.env.smoke` loses its fixed admin password → `up -d` (new secrets; asserts the admin password changed and that the stored login is rejected by the fresh cell) → `cell-restore.sh --compose . --yes` → `whoami`/`doctor` with the **original** stored OAuth login (no Keycloak token — proves cell key, API secrets and the token hash came back) → the project exists → `init show` and the welcome banner show the admin password from before the backup.
- `smoke.sh` runs the stack from its own `.env.smoke` (`COMPOSE_ENV_FILES`, inherited by the backup/restore scripts) generated from `.env.example` with the hostile values; the user's `.env` is never read or written, and `--check` creates nothing. `.env.smoke`, `.smoke-*` and `smoke-backups/` are git-ignored in both repositories.
- `scripts/lib/compose.test.sh` grew: health wait (JSON lines and array shapes, diagnostics on timeout), a full restore through the shim (registry blobs counted, role alignment and the stop list asserted), a simulated short extraction rejected.
- Not verifiable here (no Docker): the live run of this scenario is what the next CI `compose` job will show.

### Fix: `cell-backup.sh --compose -d` could not write the archive to the host ("Permission denied")
- The copy-out ran the backup container (uid 10001) with the host directory bind-mounted at `/out`; that directory belongs to whoever runs the script (uid 1001 on the CI runner, any laptop), so `cp … /out/` failed after a successful backup. Bind mounts are gone from the copy paths: the archive and its `.sha256` are streamed out through the container's stdout (`compose run -T … cat`), the host directory is created first, the sha256 is verified after the copy, and the final host path, size and sha256 are printed (`compose_download` in `scripts/lib/compose.sh`). Same treatment for the copy-in of `cell-restore.sh --compose`: the archive's `secrets/` are streamed over stdin into the init container (`tar | compose run -T init … restore-secrets`) and `registry.tar` into the registry container — the temp directory a restore unpacks into is 0700 of the invoking user, unreadable by the container uids. The Helm path already streamed through `kubectl exec … cat`.
- New `scripts/lib/compose.test.sh` (layout CI job, runs as the unprivileged runner user): a `docker` shim executes the scripts `compose run` is handed against a temp dir and refuses any `-v` — checks copy-out (streamed, byte-identical, sha256 verified, a corrupted copy detected, `-T` present), and copy-in reaching `compose-init.sh restore-secrets` with the secret restored. Verified here as root and as `nobody`.
- Still unexercised: `down -v` → restore → post-restore doctor / project check (next CI run).

### Fix: smoke.sh exit 127 with a multi-word MATELOT_CLI; shellcheck in CI
- `cli_json` ran `"$MATELOT_CLI"` as one word, so CI's `MATELOT_CLI="node ../../apps/cli/dist/index.js"` became a program named `node ../../apps/cli/dist/index.js` (exit 127 at the "runners stay online" step; the earlier doctor calls predated the helper and split by accident). The CLI command is now a bash array split once on purpose (`read -ra CLI <<< "$MATELOT_CLI"`), and every CLI call in `smoke.sh` goes through `cli` / `cli_json`. New `smoke.sh --check` resolves the CLI and prints its version without Docker.
- Layout CI job: `bash -n` + `shellcheck -S warning` over `scripts/*.sh`, `scripts/lib/*.sh`, `deploy/compose/**/*.sh` and the chart hooks (SC2086/SC2089 would have caught this), then builds the CLI and runs `smoke.sh --check` with the two-word command CI uses. The findings shellcheck had on the existing scripts are fixed (unchecked `cd` in `scripts/lib/compose.sh`, an unused variable in `regen-snapshot.sh`, a missing shell directive in `scripts/lib/wait.sh`, two constructs in `check-layout.sh`).
- Still unexercised: workspace/team/project with the write token, the DELETE refusal, the pipeline on the Compose runner, backup → `down -v` → restore.

### Fix: token scope is a mask over the user's own role (write-scoped admin can create a workspace)
- **Root cause of `403 Missing permission workspace:write on organization` right after `matelot login`:** a personal / OAuth token with the default `write` scope replaced the user's roles with a fixed PRODUCT_SECURITY_ENGINEER, so the administrator who had just installed the cell could not create the first workspace. That downgrade kept breaking first-run flows and is gone.
- **Semantics, decided and enforced in two places:** the scope is a mask over whatever the user's own roles (or cell-admin mode) grant — `read` = every `*:read` plus `registry:pull` / `gate:evaluate`, safe HTTP methods only; `write` = everything the roles allow **except** the administrative permissions `SUDO_ONLY` (`organization:write`, `organization:create_child`, `membership:write`, `integration:write`/`connect`, `policy:write`, `exception:approve`, `policy:exception_approve`, `risk:accept`, `compliance:write`, `runner:write`) and any `DELETE` route (archive / remove: workspaces, projects, teams, policies, integrations, memberships, tokens, runner pools); `sudo` = the full role. Permission mask: `scopeAllows()` in `rbac/permissions.ts`, applied by `AuthorizationService.permissionsFor` via `AccessContext.tokenScope`; method rule: `methodRefusedForScope()` in `personal-token.guard.ts` ("Deleting or archiving needs a sudo token"). The mask only removes, never adds: a DEVELOPER's write token is still a DEVELOPER; the platform-admin flag on the request still needs `sudo` (Administration area), while an administrator's visibility and day-to-day permissions carry over to `write`.
- **Specs:** `token-scope-matrix.spec.ts` now walks the customer's first-run path with a write-scoped ORG_ADMIN token and with a cell administrator without memberships (the Compose admin) — create workspace → team → project → run a pipeline → read findings → push to the registry — and asserts that only the administrative actions need sudo; it pins the exact `SUDO_ONLY` set, checks the mask for every permission and the method rule (read: GET only; write: no DELETE; sudo: all; MCP transport exempt). `token-access.spec.ts` kept (admin write token: reads and decides on findings, cannot grant memberships).
- **Docs:** `docs/roles.md` carries one permission × scope table (read / write / sudo, what each row is used for) plus the consent-page action table; `docs/access-tokens.md`, the OAuth consent copy and the MCP `matelot_start_here` text say the same thing.
- **smoke.sh:** CLI calls go through `cli_json` — the CLI's exit status is checked first and its stderr (and stdout) printed on failure, so a 403 reads as `403 Missing permission …` instead of python's `Expecting value: line 1 column 1`; a new step asserts the write scope stops where it should (`DELETE /projects/:id` with the login token is refused with the sudo message, the project stays).
- **CLI 2.22.2:** `matelot use http://localhost:80/` echoes and stores the normalised URL (`current cell: http://localhost`); test added.
- Still unverified here (no Docker daemon in this environment): the project pipeline on the Compose runner and backup → `down -v` → restore remain CI-only steps.

### Fix: one spelling per cell URL (default port, host case, trailing slash)
- `smoke.sh` compared origins as strings, so `http://localhost:80` (its own base) and `http://localhost` (what the cell advertises) failed its discovery assertion although doctor passed. The check now normalises both sides like the CLI does (scheme + lower-case host, default port dropped).
- **CLI 2.22.1:** `normalizeCellUrl()` — scheme and host lower-case, `:80`/`:443` dropped for http/https, no trailing slash, path prefix kept — is applied to `--url`, `MATELOT_URL`, the credentials keys and `current`, so `--url http://localhost:80` and `--url http://localhost/` are the same cell and cannot create two entries; `login` stores under the normalised URL. Origin comparisons in `discover()` and doctor already went through `URL.origin` (which applies the same rule). Unit tests: default ports, non-default port kept, host case, trailing slash, whitespace, path prefix; plus a CLI test that `use`/`whoami` with a trailing slash hit the existing entry.

### Fix: CLI cell context (multi-login credentials); runners invisible to write-scoped tokens; doctor says what it checked
- **CLI 2.22.0 — a current cell.** `credentials.json` keeps one entry per URL plus `current`; `login` makes the cell it just logged into current, `matelot use <url>` switches, `matelot cells` lists stored logins (user, scope, valid/expired/logged out, `*` on the current one), `logout` removes the entry and clears `current` when it pointed there. Every command resolves its cell as **`--url` > `MATELOT_URL` > current > the only stored login**, and with several entries and none current it stops with "no cell selected — run matelot login --url … (or matelot use <url>)" — never the first entry. `--url` is honoured by every command (`whoami`, `doctor`, resources) by taking precedence over `MATELOT_URL`; an empty `MATELOT_URL` counts as unset. `doctor`'s login line names the cell it checked ("user admin@localhost on http://localhost"). Old files without `current` load unchanged. Test: a legacy two-entry file with the expired cell first — `whoami` without context errors clearly, `--url`/`MATELOT_URL`/`use` all reach the valid cell, `doctor --url <expired>` reports *that* cell's login as expired, `logout` removes the entry.
- **Runners "(empty)" / "no runner online" after `matelot login`:** a `write`-scoped OAuth/personal token of an administrator is deliberately downgraded to the PRODUCT_SECURITY_ENGINEER role, and that role had no `runner:read`, so `GET /organizations/:org/runner-pools` filtered out every pool — including the cell's managed one — while the same user saw it with a Keycloak session (CI). PRODUCT_SECURITY_ENGINEER now has `runner:read` (seeing where your jobs run is a read; the token-scope matrix spec gained the row "see runners": read ✓ write ✓ sudo ✓). The heartbeat write path was correct (`POST /runner/heartbeat` sets `status` + `lastHeartbeatAt`; the sweeper marks a runner offline after 60 s of silence): a new test registers two runners with 5-minute-old heartbeats, heartbeats one, runs the sweep, and expects online / offline.
- `doctor`'s runners line names the endpoint and scope it checked ("— GET /organizations/main/runner-pools: 1 pool(s) incl. the cell's managed pool"); `smoke.sh` runs `matelot cells`, and re-runs `doctor` 75 s after the first pass (past the 60 s stale threshold) asserting the runners check is still green, so staleness fails CI.

### Fix: OAuth metadata advertised the API's listen address; discovery checks in login and doctor
- **CI blocker:** the well-known document (and the keyless identity issuer, the MCP resource metadata) used `API_PUBLIC_URL`, which neither the chart nor the Compose stack set, so it fell back to `http://localhost:3000` — a port no proxy exposes; `matelot login` printed a dead link. One helper, `publicApiBase()` (`apps/api/src/config/public-url.ts`): **`API_PUBLIC_URL`, else `WEB_BASE_URL`** (the cell's public URL, under which `/api` reaches the API), last resort `http://localhost:<PORT>`; used by the OAuth service, the identity service and the MCP `WWW-Authenticate` header. Set explicitly everywhere anyway: `compose-init.sh` (`API_PUBLIC_URL=<public URL>`, unit-tested in both modes), the chart's `api-configmap.yaml` (`<scheme>://<slug>.<domain>`, asserted by chart-test), the dev `.env.example` note. Unit test: precedence, and the metadata document built from `http://localhost` never contains `localhost:3000`.
- **CLI 2.21.0:** `discover()` warns when the advertised endpoints are on another origin than `--url` ("the cell advertises http://localhost:3000 but you connected to http://localhost — check API_PUBLIC_URL on the cell …") instead of handing over a dead link; `matelot doctor` has a **discovery** line — JSON (not the web app), HTTP 200 with OAuth metadata, endpoints on the cell's own origin — tested for the healthy, HTML and wrong-origin cases.
- **`smoke.sh`:** prints the discovery document and asserts its endpoints are on the cell URL before the login; prints the authorize link it follows and, when following it fails, the curl exit code, the discovery document and the response headers.

### Fix: GitHub Pages source self-healing (site showed the README twice)
- GitHub reset the website's Pages source to the legacy branch build on its own (both times right after the custom domain was written), so matelot.cloud served the repository README. `pages.yml` now, before every `deploy-pages`, reads the Pages settings and puts `build_type=workflow` back when it is anything else (`gh api -X PUT repos/…/pages -f build_type=workflow`; `POST` when the site does not exist yet), with `GITHUB_TOKEN` (`pages: write`) or, if set, the repository secret `PAGES_ADMIN_TOKEN`. The workflow also listens to `repository_dispatch: docs-synced`; `docs-sync.yml` and `release.yml` send it after pushing docs (`gh api -X POST repos/<org>/website/dispatches` with `PUBLIC_REPOS_TOKEN`, Contents write is enough), so the source is healed even when no commit was made. Website README: the only supported source is "GitHub Actions", `SITE_DOMAIN` is the one place for the domain, editing it in the Pages UI is what resets the source. release-process.md updated; the example domain is `matelot.cloud`.

### Fix: public `GET /api/v1/version` for doctor; `/.well-known` routed to the API on every install path; real `matelot login` in the smoke test
- **CI blocker:** `matelot doctor` read the version from `/api/v1/meta`, which needs a token (401). New public endpoint **`GET /api/v1/version`** → `{"name":"matelot","version":"<APP_VERSION>"}` (`VersionController`, `@Public`); doctor (CLI 2.20.2) uses it, so the version shows before login, and it is documented with the health probes in docs/endpoints.md for monitoring.
- **`matelot login` through a proxy:** OAuth discovery (`/.well-known/oauth-authorization-server`) fell through to the web app's `index.html` on Compose (Caddy routed only `/api`, `/auth`, `/healthz`) — and the Helm ingress had the same gap (`/api` and `/` only), as did the Vite dev proxy. All three now route `/.well-known/*` to the API: the generated Caddyfile (`handle /.well-known/*`, checked by the init unit test), the app Ingress (`path: /.well-known`, checked by chart-test), `vite.config.ts`. The CLI's discovery is a named step now (`discover()`): an HTML or non-JSON answer reports "`…/.well-known/oauth-authorization-server returned HTML (HTTP 200) — is /.well-known routed to the API by the reverse proxy / ingress of this cell?`" instead of a JSON parse error (unit-tested against a server that answers with the SPA).
- **Smoke test covers the real login path:** `smoke.sh` runs `matelot login --url … --no-browser --scope write` in the background, takes the authorize link it prints, follows it through the proxy (must redirect to the consent page), approves with the administrator's Keycloak session (`POST /api/v1/oauth/approve`), calls the CLI's local callback, then uses the **stored login** (no `MATELOT_TOKEN`) for `whoami`, `doctor` and the project creation; credentials go to `.smoke-credentials.json` in the stack folder and are removed. The post-restore checks still use a fresh Keycloak token.

### Fix: generated env files were not shell-safe (api exit 127 on "My organization"); hostile-value tests; doctor names the broken container
- **Blocking:** `compose-init.sh` wrote `KEY=value` files unquoted and the api/worker/keycloak/welcome entrypoints source them with `sh`, so the default `BOOTSTRAP_ORG_NAME=My organization` ran `organization` as a command (`sh: 9: organization: not found`, exit 127, restart loop). Every generated KEY=value file (`env/api.env`, `env/cell.env`, `keycloak/keycloak.env`) now goes through one writer (`kv FILE KEY VALUE`) that single-quotes each value with embedded quotes escaped; the realm and `config.json` literals go through `json_str` (backslash and quote escaped). Spaces, `'`, `"`, `$`, `#`, `=`, `+` and backslashes in the organization name, admin password, e-mail or licence string are data. The secret loader was already safe (`export "$k=$(cat "$f")"`).
- **Tests:** `deploy/compose/init/compose-init.test.sh` (CI job `layout`; bash + openssl + python3, no Docker) runs the init script against a temp directory with `Acme Corp (EU) 'quoted' $HOME #1 a=b "dq" back\slash` as organization name and `p'ss$word#1=x"y` as password, sources every generated file with a POSIX `sh` and through the api entrypoint's loader, parses the realm and `config.json`, then re-runs with a domain and checks secrets are kept while Caddyfile, issuer, redirect URIs, `sslRequired`, registry host and token realm are rewritten; also `show` and `restore-secrets` (prefix mapping). `smoke.sh` now rewrites the stack's `.env` with `MATELOT_ORG_NAME='Acme Corp (EU) #1'` and `MATELOT_ADMIN_PASSWORD='Sm0ke#pass$1 ok'` before `up`, and URL-encodes the password in the token request, so this class of bug fails CI. `MATELOT_CONFIG_DIR` / `MATELOT_VOLUMES_DIR` override the paths for the test; `chown` failures outside root are warnings.
- **`matelot doctor` (CLI 2.20.1):** when the API is unreachable or not ready and the current folder (or `MATELOT_COMPOSE_DIR`) holds a `compose.yaml`, it runs `docker compose ps -a --format json` and reports every container that is not running-and-healthy (exited 0 one-shots excepted): `FAIL compose/api restarting (exit 127) — see docker compose logs api`. Tested with a fake `docker` on PATH.

### Fix: the web container could not start (nginx regex), compose diagnostics
- **Blocking:** `apps/web/nginx.conf` had the static-asset location as an unquoted regex `\.[a-z0-9]{2,5}$`; nginx reads `{` as a block opener (`unknown directive "2,5}$"`), so the web container restart-looped, `web` never became healthy and `docker compose up -d` stopped at "dependency failed to start". The regex is quoted now (nginx requires quotes around regular expressions containing `{`/`}`); the only regex location in the repository.
- **Fail fast:** the web Dockerfile runs `nginx -t` after copying the config, so a broken config fails the image build (CI `image` job, release) with the nginx message instead of an unhealthy container; the CI `compose` job also runs `docker run --rm secops/web:ci nginx -t` before `up`.
- **`smoke.sh` diagnostics:** when `up -d` fails or the cell never becomes ready, it prints `docker compose ps -a` and the last 30 log lines of every container that is not running-and-healthy (the root cause), before the `down -v` cleanup.
- Not verified here (no Docker daemon, no nginx binary in the sandbox): the quoted regex follows the nginx documentation; the Dockerfile's `nginx -t` is the gate from now on.

### Docker Compose quick start — the first install path (Helm stays the production path)
- **`deploy/compose/`** (published as `matelot-cloud/matelot` → `docker/` by `release.yml`, `.env.example` pinned to the release): `compose.yaml` with api, worker, web, runner, postgres, redis, keycloak, registry and **Caddy as the only published port pair (80/443)**; every service non-root (Caddy binds 80/443 via `ip_unprivileged_port_start`), named volumes for config, postgres, registry, backups, Caddy certificates and runner data, healthchecks everywhere, `restart: unless-stopped`, memory limits that add up to about 4 GB, json-file log rotation. Images `ghcr.io/matelot-cloud/*:${MATELOT_VERSION}`; `MATELOT_REGISTRY_PREFIX` for locally built images.
- **First start:** `cp .env.example .env` (MATELOT_DOMAIN, MATELOT_ADMIN_EMAIL; nothing secret in the file), `docker compose up -d`. The `init` service (api image, the only root container, exits) generates on first start — never shipped as defaults — the Postgres and Keycloak passwords, the cell encryption key, the registry signing key pair and events secret, the managed-runner secret and the first administrator's password, into the `config` volume as `secrets/<name>/<KEY>` (the layout of the chart's Secrets, so backups restore across the two installs); it rewrites the derived configuration on every start (Caddyfile, Keycloak realm with the administrator and `platform-web` redirect URIs, `keycloak.env`, registry config, web `config.json`, `env/api.env`). The api runs the migrations then starts; Keycloak imports the realm; the `welcome` service prints the URL, the administrator login and the next commands when the cell answers (`docker compose logs welcome`; `docker compose run --rm init show`). `MATELOT_DOMAIN=localhost` = plain HTTP and the registry on `localhost:5000`; a real domain = automatic Let's Encrypt for `<domain>` and `registry.<domain>` (Docker login needs a hostname, so the registry is a subdomain; Keycloak is served under `/auth` on the main host, so two DNS names in total). `init realm-update` re-points an imported realm after a domain change.
- **`matelot doctor [--url]`** (CLI 2.20.0): API ready, version, login, organization, runners online, registry — one line each, `--json`, exit 1 on a failure; the unauthenticated checks run without credentials. Tested against a stub API (all green, runner offline → exit 1, no credentials → skipped, unreachable).
- **Day 2:** `scripts/cell-backup.sh --compose [DIR] [-d ./backups] [--list]` runs the stack's `backup` profile (pg_dump of both databases + the secrets + **the registry blobs as `registry.tar`**, `backup.sh` gained `REGISTRY_DIR`) and downloads the archive; `scripts/cell-restore.sh --compose [DIR] [--secrets-only|--databases-only] ARCHIVE` restores the secrets into the `config` volume (`init restore-secrets`, strips a Kubernetes release prefix), the databases inside the postgres container (`restore-db.sh`) and the blobs, then starts the stack; the Kubernetes restore accepts Compose archives (adds the prefix). Upgrade = `MATELOT_VERSION` + `docker compose pull && up -d` (only the four app services restart); rollback and its migration caveat documented.
- **Web image:** `/config.json` is now served from `/matelot/web/config.json` (nginx `alias`; the image carries the default, the chart mounts its ConfigMap there, Compose the generated file) — no more mounting a file into the html root.
- **Docs and site:** docs/install.md has **Option A: Docker Compose** first and **Option B: Kubernetes (Helm)** second with a comparison table (host vs HA, TLS, backups, upgrades, when to move); docs/backup-restore.md § Compose; landing page "Start free — Docker Compose" (hero, Free tier, CTA) points at the quick start; FAQ updated. Public `matelot` README has the Compose quick start first; the PR template says `docker/` is pipeline-written.
- **CI job `compose`:** builds the four images from the commit, runs `deploy/compose/smoke.sh` — `up -d` → ready through Caddy → sign in as the generated administrator (password grant) → `matelot doctor` → workspace/team/project → `cell-backup.sh --compose` → `down -v` → `cell-restore.sh --compose` → the project is back — and dumps the logs on failure. `scripts/chart-test.sh` checks the compose copies of `backup.sh`/`restore-db.sh` match the chart's and renders `compose.yaml`. Release notes name the compose stack and the version to set.
- **Licensing hook (M13):** `MATELOT_LICENSE` in `.env`, chart value `license`, API env (accepted, ignored); Settings → License comes with M13 without changing the stack.
- Not run here: the stack itself (no Docker daemon in the build sandbox). Verified: `docker compose config` with the example env, the init script in both localhost and domain modes (secrets generated once, config rewritten, valid JSON/Caddyfile), the CLI tests, the docs build. The first `compose` CI run and the clean-VM pass in the request are the real verification — expect the first run to surface something in the Keycloak healthcheck or Caddy details; the logs step is there for that.

### CLI installs from the release tarball; the git form is forbidden
- **Root cause of "matelot: command not found" with `npm install -g github:…`:** npm 10.9 links a global git install to its temporary clone under `~/.npm/_cacache/tmp/git-clone…` and then deletes it, leaving `node_modules/matelot-cli` as a dangling symlink (reproduced here as an empty package directory). Installing from a tarball produces a real directory.
- **`publish-cli.yml`** now also creates a GitHub Release `vX.Y.Z` in `matelot-cloud/setup-cli` with the `npm pack` package attached twice: `matelot-cli-X.Y.Z.tgz` (pinned URL) and `matelot-cli.tgz` (fixed name, so `releases/latest/download/matelot-cli.tgz` always resolves to the newest release; pre-release tags are marked pre-release and do not move `latest`). Re-runs upload with `--clobber`.
- **Every install path is the tarball:** docs/install.md, docs/ci-integration.md (with the reason the git form is wrong and the air-gapped variant), the GitLab CI and Bitbucket examples (docs + CLI), the web app's CI snippet, the READMEs of `apps/cli` and `setup-cli`. The GitHub Action installs the **source archive of its own ref** (`archive/refs/tags/<github.action_ref>.tar.gz` — works for `@v2.19.2` and the moving `@v2`; `version` overrides), which is a tarball too.
- **`install-test`** runs exactly the documented commands on a clean runner (Node only): the pinned asset, `releases/latest/download/matelot-cli.tgz` (final releases), and the moving major's source archive; each asserts `matelot --version` and `secops --version`, and the last also checks the global package is a real directory.
- The git-form fragment (repo name followed by `#`) is on the forbidden-string list, so the git form cannot come back into docs, examples, snippets or workflows. The tag-equals-`package.json` guard stays as it is.

### setup-cli installs without a build; guards cover root files and tracked files only
- **The git-form install (`github:…`) failed with `tsc: not found`:** a git install does not install devDependencies, and the published package relied on a `prepare` build. `publish-cli.yml` now commits the compiled `dist/` (tests excluded) to `setup-cli` and writes a `package.json` without `prepare`/`prepublishOnly`/devDependencies (`files: dist, README.md`), so the install is a plain copy; `public-repos/setup-cli` ships that way too. A new `install-test` job runs after the publish on a clean runner — no checkout, no pnpm, Node 20 — and installs the exact tag and the moving major, checking `matelot --version` and `secops --version`. Verified here: a git install of the public copy (`git+file://…#v2`) needs no build and resolves both binaries.
- **`scripts/check-forbidden.sh`** scans `git ls-files` only (a git-ignored leftover such as `apps/web/public/docs` is not scanned; the working-tree fallback applies only outside a git checkout and skips that folder too). When a hit is in a tracked file that `.gitignore` also matches, it says so and prints the `git rm -r --cached` to run.
- **`scripts/check-layout.sh`** now checks root *files* as well: allowed are README.md, CHANGELOG.md, CLAUDE.md, SETUP.md, Makefile, package.json, pnpm-lock.yaml, pnpm-workspace.yaml, .npmrc, .gitignore, .dockerignore, docker-compose.yml, .env.example, `LICENSE*`, `tsconfig*.json`; anything else (`ci-integration.md`, `cli.md`, `roles.md` … from old drops) fails with the entry named. Git-ignored root entries (`.env`, `node_modules`) are excepted. Tested in a scratch git repo: stray `roles.md` and `helm/` fail, an ignored `.env` passes, a tracked-but-ignored file is flagged with the fix.

### Organization renamed: `matelot-cloud` (was the previous slug)
- Every name of the GitHub organization moved: image defaults `ghcr.io/matelot-cloud/{api,web,worker,runner}` and `oci://ghcr.io/matelot-cloud/charts/secops-cell` (chart values, cell template, production example, docs, install guide), the Pages URL `https://matelot-cloud.github.io/website` (website build default, `docsUrl` defaults in the web app and chart, OG/sitemap/robots URLs, docs header and footer links), `matelot-cloud/setup-cli` (action, docs, examples, web CI snippets, `package.json`), OCI labels, the public READMEs / SECURITY / SUPPORT / issue templates / profile, CLAUDE.md and release-process.md.
- **One constant per place:** `ORG` and `SITE` env at the top of `release.yml` (labels, cosign identity, release notes), `ORG` in `publish-cli.yml` and `docs-sync.yml`, `ORG` in `tools/docs-site/build.mjs`, and `org` in the website's `content.json` with `{{org}}` in every URL of that file (resolved by its build and tests). Chart values, Markdown docs and public READMEs still carry the literal name (there is nothing to template them with), which is why:
- **`scripts/check-forbidden.sh`** (CI job `layout`, `make check-layout`) fails on any retired name — the previous organization slug, the old CLI mirror, the old placeholder domain — across tracked files; the website and helm-charts workflows run the same grep. A rename is: replace, add the old name to the list, green CI.
- The Docker action majors (`login-action` v4, `setup-qemu`/`setup-buildx` v4, `metadata-action` v6, `build-push-action` v7) are in place again after the revert on main.

### Release pipeline after the first end-to-end run (v0.1.0-rc.3); CLI published as `matelot-cloud/setup-cli`
- **Folded in from main:** the runner image builds with `apps/runner` as its context (`context` per matrix entry in `release.yml` and `ci.yml`); the chart job logs in with `docker/login-action` before `helm push` / `cosign sign` (cosign reads Docker's credential store, `helm registry login` does not write it).
- **Release notes guard:** `scripts/changelog-section.sh` exits 2 when no `## vX.Y.Z` section exists; `release.yml` accepts that with a warning for pre-release tags and **fails the release job for a final tag** before anything is created in `matelot`.
- **Actions on the Node 24 runtime:** checkout v7, setup-node v7, pnpm/action-setup v6, upload-artifact v7 / download-artifact v8, azure/setup-helm v5, docker login v4 / setup-qemu v4 / setup-buildx v4 / metadata v6 / build-push v7, upload-pages-artifact v5 / deploy-pages v5 — in platform, website and helm-charts workflows. `sigstore/cosign-installer` stays on v3 deliberately (v4 = cosign 3, new bundle format that cosign 2 clients cannot verify). Runners pinned to `ubuntu-24.04`.
- **Docs (release-process.md):** `PUBLIC_REPOS_TOKEN` is a *repository* secret on `platform` (organization secrets are not shared with private repositories on the Free plan); organization *Package creation: Public* must be enabled before a package can be switched to public; Pages → Source: GitHub Actions is set by hand before the first website push; the token now also covers `setup-cli`.
- **CLI goes public as `matelot-cloud/setup-cli`** (`public-repos/setup-cli`): the CLI source (Apache-2.0, zero dependencies, nothing server-side), `examples/`, and `action.yml` in one repository, so the git-form install and `uses: matelot-cloud/setup-cli@v2` both worked at the time (superseded: see the release-tarball entry); the action installs the CLI at the tag it was used with (`github.action_ref`), `version` overrides. `publish-cli.yml` (tag `cli-vX.Y.Z`) builds, tests, pushes the package to `setup-cli` with tags `vX.Y.Z` + moving `vX`, and publishes to npm only when `NPM_TOKEN` is set. The stale `tools/setup-cli` (SECOPS_* names, old mirror) is removed; `apps/cli/action.yml` is the source. Every install reference now points at `matelot-cloud/setup-cli`: docs/ci-integration.md, docs/install.md, the CI examples (docs + CLI), `package.json` repository/homepage/bugs, the web app's CI snippets (`ci-snippets.tsx`, `CiTokenParts.tsx`). Verified: the public copy builds and runs from a clean clone (`npm install && npm run build` → 2.19.2, `npm pack` 23 files).

### Fix: drizzle snapshot regenerated (CI "schema in sync" green); repository layout guard
- **Snapshot.** Migrations 0026–0047 were hand-written without regenerating `apps/api/drizzle/meta`, so the last snapshot was 0025 and `drizzle-kit generate` proposed a 0048 re-creating everything since. `meta/0047_snapshot.json` is now the current schema (generated from `schema.ts`, no SQL added, journal unchanged); `generate` reports "No schema changes". Checked against a database built by applying all 48 migrations from scratch with `drizzle-kit push --strict` (dry): the only differences are Postgres-default constraint names in hand-written SQL (`_fkey`/`_pkey` instead of drizzle's `_fk`/`_pk`) and `'{}'::text[]` defaults — no missing or extra column, table, enum value or index. Three indexes that existed only in SQL (`findings_running_idx`, `findings_canonical_idx`, the partial unique `runner_pools_one_managed`) are now declared in `schema.ts` so a future `generate` cannot drop them. No 0048 ships; existing databases are untouched.
- **CI check** now fails on *any* change under `apps/api/drizzle` after `generate` (the old `git diff --exit-code` ignored the new untracked files, so it could only catch edits). New `scripts/regen-snapshot.sh` for the hand-written-SQL case (keeps the generated snapshot, drops the generated SQL + journal entry, asserts no-op). Rule in CLAUDE.md § Working on the schema and README: migration SQL + regenerated snapshot in the same commit; name constraints the drizzle way.
- **Layout guard.** `scripts/check-layout.sh` (CI job `layout`, `make check-layout`) fails when the repository root holds a directory outside `.github apps deploy docs packages scripts tools` (git-ignored folders excluded) — stale pre-monorepo copies left by rsync'ed drops (`api/`, `cli/`, `helm/`, …) cannot come back unnoticed. CLAUDE.md § Repository layout: a moved folder is `git rm`'d in the same change; drops mirror the layout exactly (this zip: those seven directories plus root files).
- `.gitignore`: `/coverage/` + `apps/*/coverage/` instead of `coverage/` (which hid `apps/web/src/pages/coverage`).

### GitHub organization `matelot-cloud`, public repositories, release pipeline, self-hosted website
- **Business model in the product:** closed source, self-hosted. Customers install one cell from the public chart and the public images; the website shows the three per-user tiers (Free / Premium / Ultimate, GitLab-style, **indicative**); licensing and entitlements are M13 (nothing enforced in this drop).
- **Images and chart point at the organization:** defaults `ghcr.io/matelot-cloud/{api,web,worker,runner}` everywhere (chart values, cell template, production example, Makefile, provision script, docs, runner Dockerfile, API `RUNNER_IMAGE` default). The worker is now its own image (`FROM runtime AS worker` in `apps/api/Dockerfile`, `worker.image` in the chart; `make image` builds it, CI builds the target). `Chart.yaml` carries description, `home`, `sources` (helm-charts, matelot), maintainers and icon. The chart sets `APP_VERSION` on the API from the image tag, so `GET /api/v1/meta` and the web footer ("API x.y.z") show the cell version. `NOTES.txt` and the backup comments point at the public scripts and the public docs instead of repository paths; `cell-restore.sh` finds `restore-db.sh` next to either chart layout (`CHART_DIR` override).
- **Release pipeline** `.github/workflows/release.yml` on `v*` tags: four images for linux/amd64 + arm64 tagged `X.Y.Z`, `vX.Y.Z` and `latest` (not for pre-releases), cosign-signed (keyless, GitHub OIDC), syft SPDX SBOMs attached as attestations and uploaded as artifacts; `helm package` with the tag's version, `helm push` to `oci://ghcr.io/matelot-cloud/charts/secops-cell`, chart digest signed; chart folder + `cell-backup.sh`/`cell-restore.sh` + lib synced to `matelot-cloud/helm-charts` (tag `secops-cell-X.Y.Z`); docs rendered into `matelot-cloud/website` as `docs/vX.Y/` and `docs/latest/`; GitHub Release in `matelot-cloud/matelot` with the `CHANGELOG.md` section (`scripts/changelog-section.sh`), image and chart digests, `cosign verify` commands and the SBOM files. `docs-sync.yml` keeps `website/docs/latest` equal to `main`. Cross-repository pushes use the organization secret **`PUBLIC_REPOS_TOKEN`** (fine-grained PAT: Contents read/write on website, helm-charts, matelot; permissions and rotation in docs/release-process.md); `GITHUB_TOKEN` for ghcr. CI: docs render + link check replaces the old site test, worker image build added.
- **Website moves to its own repository** (`public-repos/website`, → `matelot-cloud/website`): landing page sources (`content.json`, Luminary template, assets, `tools/landing.mjs`), a build that takes the docs from committed folders (`docs/latest`, `docs/vX.Y`; `versions.json` and the redirect are generated from the folders), the link checker and tests, `pages.yml` (build + deploy-pages on push to main), **custom domain as one repository variable `SITE_DOMAIN`** (empty = `https://matelot-cloud.github.io/website`; set = CNAME, sitemap, robots and preview URLs). Content rewritten for self-hosting: hero ("Install Matelot" first), metrics, capabilities, FAQ (self-hosted, requirements, data residency, closed source + signed images, keyless, CRA, runners, CI, pricing, upgrades, AI), pricing with prices from the content file (currency, unit, per-tier price and billing, "Indicative" on every card, no toggle), footer Documentation / Install / Helm chart / GitHub / security@ / sales@. Testimonials stay off. `site/` and `tools/site/` are removed from the platform repository; `tools/docs-site/` stays (generator, tests `tools/docs-site/test.mjs`, `make docs-check`, `make docs-sync WEBSITE_DIR=../website` for a full-site preview). The 404 page works under the `/website/` base path.
- **Docs for customers:** new `docs/install.md` ("Install Matelot": requirements, values, `helm install` from the OCI chart, first backup, first administrator and identity provider, CLI, backups, upgrades, removal) first in the "Start here" section; shared docs header Home / Docs / Install / GitHub with the public links as build-time constants; the product page "Builds, releases, deployments" is now `docs/builds-releases-deployments.md` and **`docs/release-process.md` is the internal release runbook** (not published): cutting a release, one-time setup (packages public, Pages, discussions, private vulnerability reporting), the token's permissions and rotation, what syncs where. Public docs may not link into the private repository (such links fail the build). docs/backup-restore.md says where customers get the scripts; docs/cell-provisioning.md (our `deploy/cells` runbook) is no longer published — the install guide is the customer path. TOC entries with an apostrophe are no longer double-escaped.
- **Public repositories** delivered as `public-repos/` next to the platform drop, ready to copy into the clones: `matelot` (README with links, screenshots placeholder, EULA draft as LICENSE, SECURITY.md with private advisories / security@matelot.io, CODE_OF_CONDUCT.md, SUPPORT.md, CHANGELOG.md for v0.1.0, issue templates with cell/CLI/chart version fields, config.yml pointing questions to Discussions, PR template "no code PRs"), `.github` (profile README with logo and links, default SECURITY/CODE_OF_CONDUCT/SUPPORT, no FUNDING), `helm-charts` (chart copy, backup/restore scripts, README with install, ingress/TLS, database, backups, upgrades, verification; lint workflow), `website` (above, with `docs/latest` pre-generated). Nothing proprietary: no source code, no internal scripts beyond backup/restore, no internal docs.
- Not verified from here: the workflows have not run (no GitHub access from the build sandbox) — the dry run on `v0.1.0-rc.1` is the first thing to do after pushing; what to check is listed in docs/release-process.md § Cutting a release.

## Public website: landing page + versioned documentation on GitHub Pages (replaces the in-app docs)
- **`site/`** is the public site. The landing page is built on TemplateMo 621 "Luminary" (vendored stylesheet, script and images in `site/assets/vendor/` with the required credit; `timer.html` dropped): hero, three feature pillars (inventory/SBOM, policies and gates, CRA evidence), eight capability cards, integrations that exist today (GitHub, GitLab, Bitbucket, ECR, ACR, Artifact Registry, Docker Hub, GHCR, AWS/Azure/Google keyless, Jira, Slack, Teams, webhooks, e-mail, Kubernetes, MCP), three **indicative** pricing tiers with "Contact us" (no prices, no monthly/annual toggle; marked indicative), eight real FAQ entries, CTA and footer (Documentation, GitHub, contact e-mail). Testimonials are disabled until there are real quotes. **Every string lives in `site/content.json`**; the structure is `tools/site/landing.mjs`.
- **Documentation** under `docs/`: `tools/docs-site/build.mjs` is now a module building one version folder; `tools/site/build.mjs` builds `docs/latest/` from the working tree and `docs/<tag>/` from the `docs/` of every `v*` git tag (`git archive`), writes `docs/versions.json`, and every page has a version switcher that keeps the same page when it exists in the chosen version. The docs are restyled on the template's palette and type (Montserrat, the dark Luminary surface) with the shared header (logo, Home / Docs, search, version). The product name is a build-time constant. The landing page's look is dark by design; the docs match it.
- **Checks:** the build fails on any relative link or anchor without a target anywhere in the generated site (landing page included, root-absolute links too). `tools/site/test.mjs` (CI and `make site-check`) checks the landing content against `content.json`, that no template copy survived and the credit is present, the docs pages, rewritten links, version meta and search index. The versioned path was tested in a scratch git repo: a tag's docs stay as they were while `latest` shows the edit; a doc deleted on main that others link to fails the build with the file and link named.
- **GitHub Pages:** `.github/workflows/site.yml` builds and deploys on every push to `main` and on `v*` tags (`actions/upload-pages-artifact` + `deploy-pages`; one-time setting: Pages → Source: GitHub Actions). `site/CNAME` carries the custom domain (a placeholder domain; how to change it is in docs/release-process.md), plus `404.html`, `robots.txt`, `sitemap.xml` and `.nojekyll`. `make site` builds locally into `site/dist/`.
- **Web app:** no docs bundling any more — the web build, Dockerfile and `.dockerignore` are back to before (and `site/`, `tools/site`, `tools/docs-site` are excluded from image contexts). The sidebar's "Documentation" opens the public site in a new tab from `docsUrl` in `config.json`; the chart value `web.docsUrl` (default the placeholder docs domain of that drop) sets it per cell, for a mirror in an air-gapped environment. Render test covers the link; chart-test checks the config.
- **nginx:** a request path with a file extension is served as a static file or answers 404 (`/docs/nu-exista.html` no longer returns the SPA's index.html); application routes without an extension still fall back to the SPA. `/assets/` keeps its immutable caching.
- Docs: README § The public website; docs/release-process.md § The website (what is built from where, versioning rules, custom domain); `site/README.md`.

## M12 slice 7 — documentation site (M12 complete)
- `tools/docs-site/build.mjs` renders `docs/*.md` (22 pages in six sections: start here, CLI and automation, connections and registries, runners, operating a cell, reference incl. the ADRs) into a static site with navigation, client-side search (`/` focuses it; keyboard navigation), an "on this page" column, anchored headings, light/dark following the system, and a mobile layout with a collapsible contents list. Links between docs become page links, links into the repository go to GitHub, and the build fails on a link with no target. The product name comes from the cell's `/config.json`; the footer shows the version and the source file.
- The web build runs it first, so the site ships inside the web image and every cell serves its own documentation at **/docs/**; "Documentation" in the sidebar opens it. `.dockerignore` now lets `docs/` (minus roadmap and the long concept) into the build context; `marked` is the renderer (web devDependency).
- Source fix found by the site: five CLI table rows had a `|` inside a code span, which split the cell on GitHub too — escaped.
- Tests: `tools/docs-site/test.mjs` (part of the web test script) builds into a temp dir and checks pages, rewritten links, anchors, current-page marking, the search index (no HTML entities) and the CLI table rows; CI runs the link check before the web build. Looked at in a headless browser in light, dark and phone widths.

## Usage: runner-minute breakdown adds up; seats before tracking shown as "—" — CLI 2.19.2
- **Breakdown vs total.** Each job type was rounded to a tenth of a minute independently, so the parts could exceed the total (0.9+0.8+0.5+0.4+0.3+0.3 = 3.2 against a total of 3.1). The total is still the rounded raw sum; the per-type figures are now apportioned in tenths by largest remainder so they sum to the total exactly (same numbers in the API, the Usage page and `matelot usage`). Unit-tested on that exact case and on a database month.
- **Seats in history.** `usage_active_users` only exists since the metering drop, so months that ended before the first tracked request had no seat data and the snapshot stored `active: 0` next to real pipeline and job counts. `seats.active` is now `null` for such months (API), shown as "—" in the CLI history and on the Usage page ("not tracked yet that month"), and empty in the CSV. Snapshots already written with 0 are presented the same way at read time, so September reads correctly without a migration. The rule: a month counts as tracked once it ends after the cell's first recorded active user.

## Wait output: Warning events first; timeout summary never empty
- A stuck pod's warning now quotes its newest **Warning** event (Failed / BackOff) rather than a newer Normal one such as "Pulling image …"; the progress-event exception for Pending pods still looks at the newest event of any type. Test added.
- The "never ready:" summary at timeout falls back to the last status line when nothing was listed (only possible when the status check itself failed), so it is never blank.

## Fix: `make helm-lint` tag test failed on the registry
- The new tag test rendered the chart twice with `helm template`; without a cluster each render generates a fresh registry token key pair, and the registry's pod checksum legitimately covers that pair, so the two renders differed for a reason unrelated to the tag. The test now pins the generated secrets (as the install-vs-upgrade test does) and additionally asserts the postgres, keycloak, redis, registry and backup pod templates byte-identical across tags. A deterministic diff of those templates confirms nothing but the top-level `app.kubernetes.io/version` label changes with the tag.

## Fix: an image release rolled the whole cell; quieter waits after rollbacks; pre-upgrade backup
- **Every tag change restarted Postgres, Keycloak, Redis and the registry** because the common labels put `app.kubernetes.io/version: <tag>` and `helm.sh/chart: <chart>-<version>` into every pod template. Pod templates now use `cell.podLabels` (part-of, managed-by, instance, tenant); version and chart stay on the top-level objects. `chart-test.sh` renders two tags and asserts that only the api, worker, web and runner pod templates change (postgres, keycloak, redis, registry, backup identical).
- **Wait loop after a rollback / re-apply:** only pods of the current revision of each workload count (Deployment: the ReplicaSet with the Deployment's current revision; StatefulSet: the `updateRevision` controller-revision hash); Failed and Succeeded pods are ignored. A pod Pending for minutes is no longer flagged when its last event is scheduling, pulling or starting progress ("Successfully assigned…", "Pulling image…", "Started container…").
- **One warning per pod and condition:** ErrImagePull / ImagePullBackOff / InvalidImageName are one "image pull" condition, CrashLoopBackOff "crash loop", etc.; flipping reasons no longer repeat the warning. Tests cover all of it (`cellwait_test.py`).
- **Backups around apply:** an existing cell is backed up **before** `helm upgrade` ("pre-upgrade backup", the safety net for the rollout); a new cell gets the "first backup" after install (binds the backups PVC). `--no-backup` skips either. The helm header is printed after the pre-upgrade backup, in execution order.

## Fix: fresh provision hangs on WaitForFirstConsumer storage; progress while waiting
- **Cause (found on kind):** with `backup.pvc.enabled` the backups PVC stays Pending until the first backup Job mounts it (`volumeBindingMode: WaitForFirstConsumer` — kind's `standard`, EKS gp3, GKE `standard-rwo`, AKS `managed-csi`), and `helm upgrade --install --wait` waits for every PVC to be Bound, so a fresh `make provision` sat at "Installing it now." until the 15-minute timeout. Earlier runs only finished because a backup started in parallel bound the PVC.
- **Fix:** `cell-provision.sh apply` no longer passes `--wait` to helm. After the release status gate it waits on the Deployments and StatefulSets itself, then runs the **first backup** (`--no-first-backup` to skip), which binds the PVC and proves the backup job on day one, then the checks. docs/cell-provisioning.md and docs/backup-restore.md explain the behaviour for plain `helm … --wait` users.
- **Progress:** `scripts/lib/wait.sh` + `scripts/lib/cellwait.py` print a line every 15 s (`WAIT_INTERVAL`) while provision waits for the cell, backup/decommission wait for the backup Job, and decommission waits for the PVs: `[00:40] pods 5/8 ready · waiting: demo-api-1 (Init:0/1), demo-keycloak-1 (Running 0/1) · not blocking: pvc demo-backups (Pending, waiting for first consumer …)`. Anything that will not fix itself is flagged the moment it appears, once, with the pod's last event (ImagePullBackOff, ErrImagePull, CrashLoopBackOff, CreateContainerConfigError, a pod Pending for over 3 minutes with nothing running, a failed Job). On timeout or failure a summary names what never became ready and the `kubectl describe` / `logs` to look at. A WaitForFirstConsumer PVC is shown as "not blocking". `TIMEOUT` is now in seconds (provision 900, backup 1800).
- Tests: `scripts/lib/cellwait_test.py` (CI) covers starting / stuck / ready cells, a Pending pod with a running init container (not stuck), workloads without pods, a blocking vs a WaitForFirstConsumer PVC, running / complete / failed / missing Jobs, PV release. The loop was exercised here with fixtures changing over time (starting → stuck warning → ready), timeout and failure paths, and a full `apply` against stub helm/kubectl: wait → first backup → checks, with no `--wait` passed to helm.

## Fixes: decommission during a helm operation; tar notice on download
- `cell-decommission.sh` refuses to act while helm is busy with the release (`pending-install`, `pending-upgrade`, `pending-rollback`, `uninstalling`): "a helm operation is in progress on <release> (status …); wait for it or check helm history", exit 1. Previously it took `helm status` succeeding as "release present" and ran the final backup and uninstall underneath a running `apply --wait`. The status is also shown in the header line.
- `cell-backup.sh --download` (used by decommission's final backup) streams the archive with `kubectl exec … cat` instead of `kubectl cp`, so tar is no longer involved and its "Removing leading `/'" note cannot appear on any kubectl version; the sha256 check still verifies the transfer. Tested with stub kubectl: byte-identical download.

## Fixes from the provisioning run on kind
- **`check` readiness:** curled the API container port (3000) instead of the Service port (80), so it hung and reported '000' on a healthy cell. The port is now read from the Service, curl has `--max-time 10`, its error is shown, and the message names the URL.
- **Registry blobs on decommission:** `helm uninstall` deleted the `<release>-registry-data` PVC (and its PV) while the message claimed it was kept. The PVC now carries `helm.sh/resource-policy: keep` like the backups PVC; Postgres data is a StatefulSet volume and was never deleted. `chart-test.sh` asserts every PVC in the chart is kept, and the decommission script lists what actually remains.
- **Decommission after decommission:** `--purge` works when the release is already gone (skips the final backup with a note, deletes the namespace, waits up to 2 min for each PV and reports any that stay because of a Retain reclaim policy). Without `--purge` it says what remains and how to purge. An unreachable cluster, a missing context or a missing namespace are reported as such instead of "no release". A wrong slug at the prompt prints "aborted: slug did not match, nothing was changed".
- **Preflight:** a missing context or unreachable cluster is a hard failure first; "NOT found" ingress class / ClusterIssuer fail the preflight for `--dry-run` too.
- **helm exit codes:** `apply --dry-run` propagates a helm failure (e.g. "Kubernetes cluster unreachable") instead of printing a resource count and exiting 0. A real `apply` checks helm's exit code *and* that `helm status` says `deployed` before running the checks; otherwise it exits 1 and points to `helm history`. The "failed: context canceled" releases you saw were not produced by the script (it neither traps signals around helm nor times it out), so if it recurs with this drop, `helm history` plus the API server log at that moment are the next place to look — and `apply` now refuses to call such a release healthy.
- **Keycloak restart on first install:** `UnknownHostException: <release>-postgres` because Keycloak started before the Postgres Service had an endpoint. A `wait-for-postgres` init container (`pg_isready` with the chart's Postgres image, bundled mode only) holds it until the database answers; `chart-test.sh` asserts it. A fresh install should now show 0 restarts.
- `cell-backup.sh --download` no longer prints tar's "Removing leading `/'" note.
- Tested here with stub kubectl/helm: no context, cluster down, helm failure in dry-run, missing ClusterIssuer, the plain → purge decommission sequence, wrong-slug abort. The templates render through the stand-in renderer; `make helm-lint` runs the real checks.

## M12 slice 6 — cell provisioning
- **`scripts/cell-provision.sh`** — `new --slug --name --domain --admin` writes `deploy/cells/<slug>.values.yaml` from `deploy/cells/_template.values.yaml` (the committed inventory of cells; secrets stay out as `${VAR}` placeholders). `apply --slug [--tag] [--dry-run] [--set k=v]` runs a preflight (every placeholder has a value in the environment, ingress class and cert-manager ClusterIssuer exist, whether the three hostnames resolve), fills the placeholders into a temporary copy (deleted afterwards; values taken literally, `&` and `/` included), runs `helm upgrade --install --wait`, then the checks: API and worker rolled out, restarting pods listed, `/api/v1/health/ready` answered from inside the cluster, backup CronJob present, chart notes, handover pointers. `check --slug` runs the checks alone. `make provision TENANT=…`.
- **`scripts/cell-decommission.sh`** — final backup downloaded, `helm uninstall`; with `--purge` the namespace and every volume go too. Confirmation by typing the slug. `make decommission TENANT=… [PURGE=1]`.
- **Runbook** docs/cell-provisioning.md: cluster prerequisites, per-cell inputs, create, verify, handover (IdP in Keycloak, first admin by e-mail, setup card), day 2 (upgrade one / all cells, scale, rotate), decommission, conventions.
- CI parses every operator script (`bash -n`). Tested here: `new` writes a valid values file with the admin list; `apply --dry-run` against stub helm/kubectl (missing secrets refused, placeholders filled only in the temp copy, `--tag` applied to all three images, temp file removed); a bad slug is refused.

## Fix: first `helm upgrade` after an install rolled the api/worker pods; registry events secret generated twice
- Cause (found from the rollout-history diff: only `checksum/secret` changed, and a cell installed with the Secrets already present never rolled): the generated secrets were produced inside named templates (`randAlphaNum`, `genSelfSignedCert`), and every `include` of such a template rolled a new value. On a fresh install the api/worker `checksum/secret` therefore hashed a *second* random encryption key, not the one stored in `acme-cell-key`; on the next upgrade `lookup` returned the stored key, the hash changed, and the pods rolled once. The same double generation gave the registry's `config.yml` a different `REGISTRY_EVENTS_SECRET` than the Secret the API reads, so on a fresh install the registry's push notifications to the API were rejected until the first upgrade.
- Fix: `_helpers.tpl` resolves each generated value once per render (`cell.generated`: explicit value → existing Secret via `lookup` → generated) and remembers it in `.Values._generated`, so every include in that render returns the same value. Install and upgrade now render identical bytes; the registry config and Secret agree.
- Test: `scripts/chart-test.sh` renders the chart, reads the generated values out of the rendered Secrets, renders again with them given explicitly (what `lookup` returns on an upgrade) and requires identical pod checksums on api, worker, keycloak, registry, runner and backup, identical Secrets/ConfigMaps, and that the registry config carries the Secret's events secret. CI installs PyYAML for it when missing.

## Fixes from the first run on kind (runner 0.3.2)
- **Chart could not be installed:** `registry.yaml` computed its pod checksum by including itself (`include $.Template.BasePath/registry.yaml`), which recurses forever in `helm lint` / `install`. The registry's `config.yml` now lives in `files/registry-config.yml.tpl` (rendered with `tpl`, like the Keycloak realm) and the checksum covers that rendered config plus the token key pair, so the pod rolls when its configuration changes and only then.
- **Chart tests with the real helm:** `scripts/chart-test.sh` (`make helm-lint`, and CI's chart job) lints and renders the chart with defaults, `values-production.example.yaml`, backups on a PVC, backups to S3 only, an external database with backups, TLS, and without managed runners / registry; it also checks that the invalid combinations (backup without storage, S3 without a bucket) are refused. The stand-in renderer used here cannot run helm itself, so this is what catches template errors from now on.
- **Web image build:** `.dockerignore` excluded `**/coverage`, which dropped `apps/web/src/pages/coverage/` from the build context ("Cannot find module './pages/coverage'"). It is now `apps/*/coverage` (test output only). CI's image job also builds the runner image.
- **`scripts/kind-up.sh`** waited for ingress-nginx pods by label before they existed ("no matching resources found" on a fresh cluster); it now waits on `rollout status deployment/ingress-nginx-controller`.
- **Managed runner and the `kubernetes` tag:** the agent added `kubernetes` whenever it ran in-cluster with kubectl present, so a cluster-inventory job could land on a managed runner that has no Kubernetes API access. With `RUNNER_MANAGED_SECRET` the tag is no longer added automatically (`managedRunners.tags` can still add it on purpose).
- **Managed runner exits when the API is down:** registration failed with "fetch failed" and the process exited (3 restarts at first install, 2 during a restore). `apps/runner/src/retry.ts`: registration and the first heartbeat retry transient failures (network errors, 502/503/504/429) with backoff from 2 s to 60 s until shutdown; 4xx answers such as a wrong secret still stop the agent at once. Claim errors say when the cell is unreachable. Unit-tested (`retry.test.ts`).
- **`cell-restore.sh`** uses server-side apply for the Secrets, so Helm-created Secrets no longer print the "missing last-applied-configuration" warning.
- **Drop layout:** the zip has a `secops-platform/` top-level folder again.
- Not reproduced: enabling backups with `helm upgrade --reuse-values --set backup.enabled=true` rolled the api and worker pods. Neither the API ConfigMap nor the Secret template reads `backup.*`, and their checksums are unchanged by this drop. If it happens again, `kubectl rollout history deployment/acme-api --revision=N -o yaml` diffed against the previous revision will show which field moved.

## M12 slice 5 — cell backup and restore
- **Chart:** `backup.enabled` adds a CronJob (`<release>-backup`, cron in UTC, default 02:17) that runs `pg_dump --format=custom` of the platform and Keycloak databases with the chart's own Postgres image and packs them with the cell's Secrets (encryption key, managed-runner secret, registry key/cert/events secret, database and Keycloak credentials, API secrets) into one `<slug>-<stamp>.tar.gz` with a `.sha256` and a `latest.tar.gz` link. Archives are kept on a PVC (`backup.pvc`, pruned after `retentionDays`, kept on uninstall) and/or copied to an S3-compatible bucket (`backup.s3`: bucket, prefix, endpoint, region, credentials Secret or pod identity). With S3 the dump is an init container and the upload the main container, so they run in order. External databases (`postgres.bundled=false`) are dumped through the API's `DATABASE_URL`. The template refuses `backup.enabled` without a storage target and S3 without a bucket. NOTES.txt says where backups go, or that they are off.
- **Scripts:** `scripts/cell-backup.sh -r REL -n NS [-d DIR] [--list]` runs the CronJob now, waits, prints the log and downloads the newest archive (checksum verified) through a short-lived pod on the PVC. `scripts/cell-restore.sh -r REL -n NS [--secrets-only|--databases-only] [--yes] ARCHIVE` verifies the checksum, recreates the Secrets with Helm ownership metadata (so a later `helm install`/`upgrade` adopts them and keeps their values), scales API, worker, Keycloak and managed runners to 0, restores each database inside the Postgres pod (`files/restore-db.sh`: every dump is checked with `pg_restore --list` before anything is dropped; terminate connections, drop, create, `pg_restore --exit-on-error`), and scales back to the replica counts it found, also on failure. `make backup TENANT=…`, `make restore TENANT=… ARCHIVE=…`.
- **Runbook:** docs/backup-restore.md — what is and is not in an archive (registry blobs are not), why the encryption key matters, turning backups on, the three restore cases (roll back a running cell; rebuild on a new cluster, where the Secrets must be restored **before** `helm install`; external database), post-restore checks, and a restore drill.
- Tested here: the backup script against a real Postgres 16 in both connection modes (PG* and `DATABASE_URL`), including the `..data` symlink layout of Kubernetes secret mounts; a full round trip (back up → damage → restore, with an open connection terminated); a corrupt dump is rejected before any database is dropped and the workloads are scaled back; both operator scripts end to end against a stub `kubectl` (job creation, helper pod, download and checksum, scale 0 → restore → previous replica counts). The CronJob template renders in PVC-only, S3-only (emptyDir, retention 0) and external-database configurations. Not yet run on a real cluster.

## Fix: "1 days" in coverage output — CLI 2.19.1
- `matelot coverage --days 1` printed "security pipeline window: 1 days" and "scanned in the last 1 days". It now prints "1 day" and "in the last day". Also fixed in the API detail ("older than 1 day") and on the web (Overview summary and Coverage pages). Tests: a CLI case for `--days 1` and an API case for the stale detail with a 1-day window.

## Onboarding in two levels: organization setup and service coverage (CLI 2.19.0)
- **Why.** The organization checklist mixed one-time setup with per-service work and counted "at least one somewhere in the organization". acme showed "Attach a repository — 3 of 4 services" as done and the card said complete, while one service had no repository. With 200 projects it would read "complete" while most services were never scanned.
- **Organization setup** (the existing card: admins only, one-time, forward-only, `completedAt`) now has only organization-level steps: connect source code, get a runner working, send alerts somewhere (optional), invite your team (optional). Organizations that already completed setup stay completed. Ones that had not finished the old ten steps complete as soon as they have source code and a runner.
- **Service coverage** (new and permanent; computed from data like CRA readiness, never "done") checks each service for: a repository attached · a security pipeline finished within the last N days (default 30; older is **stale**) · an SBOM · at least one enabled policy that applies (its own, an environment's, or inherited from project / team / workspace / organization) · a deployment recorded. Each gap carries the web page and the CLI command (with ids filled in) that fix it.
  - API: `GET /projects/:id/coverage` (project:read; `days`, `gap`, `uncovered`) and `GET /organizations/:id/coverage` (organization:read, counting only projects the viewer can read; summary plus uncovered services; `gap` narrows the list, never the summary; `limit`).
  - Web: **Project → Coverage** shows one row per service with a check or a gap per column, the fix link, and the commands under each uncovered row. It follows the service selector. **Overview → Service coverage** shows "3/4 with a repository · 2/4 scanned in the last 30 days · …", and each number links to **/coverage?gap=…**, the organization-wide list of uncovered services with a tab per check. Both are visible to everyone who can read the project, not only admins.
  - CLI: `matelot coverage [--project ID] [--uncovered] [--gap CHECK] [--days N] [--json]`: per-check counts and a service table (ok / GAP / stale). `--uncovered` prints only the gaps with the command for each.
  - Docs: docs/coverage.md, docs/cli.md, roadmap M12 slice 4.
- Tests: `coverage.spec.ts` covers a covered and an uncovered service in one project, with links and commands per gap and the inherited workspace policy counted. A service scanned 40 days ago is stale with the 30-day default and ok with 60. The organization summary counts 3 services across 2 projects per check. `gap` filtering is checked, and a viewer who can read only one project sees only its services. `onboarding.spec.ts` checks the four organization-level steps, completion and forward-only behaviour. Web render covers the Overview summary, `/coverage`, `/coverage?gap=pipeline` and the project Coverage page. CLI `coverage.test.ts` checks the routes, table output and the exact `--uncovered` output. Verified live: the CLI against the API on real data (organization, `--gap`, `--uncovered`, project, and 400s for a bad `--days` / `--gap`). API 186/186, CLI 35/35, web green, API and worker boot.

## Fix: `matelot onboarding` output — CLI 2.18.2
- The header no longer repeats itself after dismiss. It reads "setup 1/10 — checklist hidden on the Overview" (also on a later `show`) and "… — checklist shown on the Overview" after restore.
- A completed organization prints "setup 10/10 — setup completed 2026-10-08" from `completedAt`. Release 2.18.1 promised this but showed it only when setup had since regressed. A dismissal from before completion is no longer mentioned.
- The API fills in real ids in step commands: the next command is `matelot connection create --org <the organization id> --body …`, and the policy step uses the first workspace once one exists. `<id>` stays only where you have to choose, such as which service.
- Open steps show their counts like done ones: "0 source connections", "0 projects · 0 services", "no service yet", "0 online, no jobs run yet", "0 pipelines · 0 finished", "0 SBOMs", "0 policies", "0 environments · 0 deployments", "0 channels". The web card shows them too.
- Tests: `onboarding.spec.ts` asserts every open step's detail on a new organization and that no command contains `<org>`. The CLI tests check exact header lines for dismiss, show-while-hidden, restore and a completed organization. The Overview render test checks "0 policies". Verified live: CLI against the API on a new organization and on a completed one. API 182/182, CLI 34/34, web green.

## Overview setup card: administrators only, no strikethrough, never comes back once done (migration 0047) — CLI 2.18.1
- **Who sees it.** The card is shown only to people who can change the organization (`organization:write`, or a platform admin). The API returns `canManage`, and developers, viewers and team members get nothing on the Overview. In an organization with many teams, nobody but the administrators sees a setup list.
- **Done means done.** `organizations.onboarding_completed_at` is set the first time every required step is done, and from then on the card never shows again (`visible: !dismissedAt && !completedAt`), even if something later regresses, such as the only policy being deleted. The API still reports the live state of each step.
- **Milestone steps.** "Get a runner working" is done once any runner is online **or** runners have run a job ("N jobs run by runners"), so runners being offline at night no longer reopens setup.
- **No strikethrough.** Completed steps are folded behind "Show N completed steps". When shown, they are muted with a green check. Open steps stay listed, and the next one is expanded with its command.
- CLI `matelot onboarding` prints "setup completed <date>" once completion is recorded. The CLI hints for `repository attach` and `sbom` are corrected.
- Tests: `onboarding.spec.ts` covers `completedAt` persistence, the runner milestone, a regression after completion staying hidden, and `canManage` for a developer, an org admin and a platform admin. `onboarding-card.mjs` checks for no `line-through`, folded done steps, nothing for a developer, and nothing after completion. API 182/182, CLI 33/33, web green.

## Dev: `make dev-stop`
- The guard showed the real cause of the EADDRINUSE restarts on a dev machine: eight leftover API watchers from earlier sessions (closed terminals / suspended jobs keep running and restart on every edit). `make dev-stop` (`scripts/dev-stop.sh`) stops every API and worker watcher of this checkout and the processes they run — matched by working directory, so `pnpm exec`'s relative `./node_modules/.bin/…` paths are found too — SIGTERM, then SIGKILL after 5 s. The guard's message points to it. Tested with three leaked API watchers + a worker: all stopped, the next `make dev` starts cleanly.

## Fix: `make dev` → "scripts/dev-guard.sh: Permission denied"
- The guard script lost its executable bit when the drop was extracted, so `make dev` / `make worker` failed with Error 126. Every Makefile recipe now runs its scripts through `bash` (`dev-guard.sh`, `token.sh`, `smoke.sh`, `kind-up.sh`; `registry-keys.sh` already did), so file modes from an archive never matter. Verified with the bit removed.

## Dev: no more EADDRINUSE on watch restarts
- Investigated `make dev` + `make worker` restarts: on this tree the worker already compiles into `apps/api/dist-worker` (`--path tsconfig.worker.json`) and never rewrites `dist/` (verified: `dist/main.js` only changes with the API build). Reproduced EADDRINUSE / "old instance keeps serving" with **two API watchers** alive at once (a previous `make dev` still running): every edit restarts both and the second one cannot bind. With exactly one `make dev` and one `make worker`, five consecutive restarts were clean.
- `scripts/dev-guard.sh` (run by `make dev` / `make worker`): refuses to start a second API watcher (or anything already listening on `PORT`) or a second worker watcher, lists the processes and the port, and says how to stop them; `DEV_GUARD=0` skips it.
- `listenWithRetry` (main.ts): the API waits up to 10 s for the port when a predecessor is still releasing it (graceful shutdown) instead of dying with EADDRINUSE; other listen errors fail at once. Unit-tested with a real occupied port.
- `apps/api/package.json`: `dev` passes `--path tsconfig.build.json` explicitly; new `dev:worker` (same as `make worker`, outDir `dist-worker`).

## M12 slice 3 — onboarding checklist (migration 0046) — CLI 2.18.0
- `GET /organizations/:id/onboarding` (organization:read): a "Get started" checklist computed from what exists — nothing to tick by hand: connect source code (a source connection, not a registry / Jira one) → a project and a service → a repository attached → a runner online (own pools or the Managed pool) → a finished security pipeline → an SBOM → a policy in force → a deployment recorded → notifications (optional) → invite the team (optional, ≥ 2 members). Each step has a description, what was found ("0 of 1 service", "6 pipelines · 6 finished"), the web page to do it (deep-linked to the first project / workspace once one exists) and the CLI command. Also `completed/total`, `requiredRemaining`, `complete`, `next`, `visible`.
- `POST …/onboarding/dismiss` and `…/restore` (organization:write, audited): hide the checklist on the Overview for everyone / show it again (`organizations.onboarding_dismissed_at`).
- Web: Overview "Get started" card (replaces the static Welcome card): progress bar, steps with done / open state, the next step expanded with its description and CLI command, "Open →" links, Hide; once hidden, a one-line "Setup N/M done. Show the setup checklist". Shown until every required step is done.
- CLI: `matelot onboarding` (checklist + the next command), `onboarding dismiss`, `onboarding restore`.
- Tests: API `onboarding.spec.ts` (a new organization walked from nothing to complete, every step flipping on the right data — registry connection is not source code, a running pipeline is not finished, one member is not a team; deep links once a project exists; dismiss / restore audited); web `test/onboarding-card.mjs` (progress, next step expanded, links, Hide → reminder → Show again) and the Overview render test; CLI `onboarding.test.ts`. Verified live with the CLI against the API. Also: the managed-runner claim test now uses its own job tag (a managed runner may legitimately claim any organization's queued job, so leftovers in a shared test database made it flaky). API 179/179, CLI 33/33, web green.

## Fix: job assignment — requeued jobs pinned to a dead runner's pool; jobs assigned to runners that had gone away (migration 0045, runner 0.3.1)
- **Requeue binding (#47).** The claim wrote the claiming runner's pool into `jobs.pool_id`, which was also the "requested pool" filter, and a lease-expiry requeue kept it: a job that asked for no pool stayed bound to the pool of the runner that abandoned it, so idle runners elsewhere (e.g. the Managed pool) never took it. New `jobs.requested_pool_id` (set at job / pipeline creation) is the only claim constraint; `pool_id` is where the job ran (UI, usage). Lease-expiry requeue, unclaim and retry restore `pool_id = requested_pool_id` (null = any eligible pool). Migration backfills `requested_pool_id` for never-claimed jobs and frees queued jobs pinned by the old requeue.
- **Runners that went away (#48).** The long-poll claim kept polling for a runner whose connection was gone and could assign it a job. The claim loop now stops when the connection closes; a job assigned in that instant, or whose response could not be delivered (connection closed before the response finished), is handed back at once (`unclaim`: status queued, attempt not counted, requested binding restored, logged "went away before receiving the job"). An assignment not started within 30 s goes back to the queue on the next sweep (the agent starts immediately), instead of waiting for the full lease.
- Runner agent 0.3.1: SIGTERM aborts the open claim (the server sees the disconnect) and the agent never starts a job after SIGTERM.
- Tests (`job-assignment.spec.ts`): after a lease expiry a job without a requested pool is claimed by a runner of another pool; a requested pool still binds after requeue; an unstarted assignment returns after 30 s without counting the attempt; a claim whose client disconnected is dropped and a job enqueued afterwards stays queued for the next runner; an undelivered job goes back while a delivered one stays assigned. Verified live with real agents: SIGTERM and SIGKILL of a self-hosted runner with an open claim → the next pipeline's job stays queued / goes to managed-0; a frozen (SIGSTOP) runner handed a job → returned after ~30 s and run by managed-0 (attempts 1). API 177/177.

## Managed runners — a fresh cell runs pipelines without a customer runner (migration 0043) — CLI 2.17.0, runner 0.3.0
- Helm chart: `managedRunners` (enabled, 1 replica): a StatefulSet of runner agents (stable names `<release>-runner-N`, no Kubernetes API access, emptyDir work volume, 10-minute graceful stop) and a generated `MANAGED_RUNNER_SECRET` (Secret kept across upgrades) given to the API and the runners. `make image` / `kind-load` build and load the runner image; `make deploy` sets it.
- API: `runner_pools.managed` (one managed pool per cell, unique index). `POST /runner/register { managedSecret, name }` registers into the Managed pool (created on first use under the bootstrap organization); the same name replaces its previous record (no offline duplicates after restarts); a wrong secret is a 401 (counts as an authentication failure); unset secret says managed runners are not enabled. The managed pool claims queued jobs of every organization (tags still apply); it is listed for every organization, cannot be deleted and has no registration tokens. The worker prunes managed runners not seen for a day (never a busy one).
- Runner agent 0.3.0: with `RUNNER_MANAGED_SECRET` it registers on every start and registers again by itself when its token is no longer accepted (401). `register()` takes a registration token or the managed secret.
- Usage: `runnerMinutesManaged` (part of runner minutes run on managed runners), CSV column `runner_minutes_managed`; the Usage tile shows it.
- Web: Runners shows the Managed pool read-only ("managed by the platform", "serves every organization and project", hint when no managed runner registered). CLI: `matelot runners list` columns include `managed`.
- Docs: `docs/managed-runners.md`.
- Tests: `managed-runners.spec.ts` (wrong / missing secret → 401; one pool, same-name replacement, old token gone; managed runner claims jobs of two organizations while a self-hosted pool stays in its own; no delete / registration token; listed for any organization; prune old but never busy; managed minutes in usage). Verified live with the real agent: wrong secret refused, registration, a checkout pipeline of another organization run on the managed runner with the commit recorded, restart without duplicate, record deleted → agent re-registered on its own. Chart templates rendered (Go text/template with Helm-function stubs; `helm` itself cannot be downloaded in this environment) and parsed as YAML, enabled and disabled. API 172/172, CLI 32/32, web green.

## Fix: pipelines without --ref failed require_sbom (migration 0044)
- `pipelines.create` stored `pipeline.ref = --ref ?? default branch`, but job payloads only got `ref` when `--ref` was passed, so the evaluate job of a plain run had an empty subject, found no SBOM and failed require_sbom although the pipeline's own sbom job had just produced one (#42, #43). Every job now gets the effective ref (the audit event records whether it was requested or the default branch).
- The commit is recorded: `pipelines.commit_sha` (new column) is set from `--commit` or by the first job that reports the commit it checked out; jobs that have not run yet get `commitSha` in their payload.
- `evaluateJob`: ref / commit from the payload, else from the pipeline (older payloads); when the pipeline ran an sbom job, its own SBOM (sboms.job_id → the pipeline's jobs) is evaluated instead of "the newest source SBOM of the service"; release lookup by commit. The evaluation records `ref`, `commitSha`, `pipelineId`, `sbomId` and `sbomSource` (`pipeline` / `lookup`).
- Messages: require_sbom for a ref subject says "No SBOM for ref main (commit …): run the pipeline's sbom job or upload one…"; for a version, "No SBOM for version …"; with no ref, commit, version or image at all, "No ref or image to evaluate…" instead of "The image has no SBOM (not scanned)".
- Tests (`pipeline-gate-subject.spec.ts`, real services + database): a security pipeline without --ref puts `ref: main` in every job, records the checkout commit (first one wins) and passes require_sbom with its own sbom job's SBOM even when a newer foreign source SBOM exists; an old empty payload falls back to the pipeline's ref/commit; both new messages. API 167/167.

## Fix: runners were rate limited as anonymous callers (per IP, 120/min)
- `RunnerAuthGuard` (a global guard — it does run before the rate-limit interceptor) stores the principal as `req.runner = { runner, pool }`, but `classify()` read `req.runner.id`, which is always undefined, so every runner request fell into the per-IP anonymous bucket: all runners behind one address (same host, node, NAT, host.docker.internal) shared 120/min with each other and with anonymous callers. Now keyed by `runner:<runner id>` in the runner class (`RATE_LIMIT_RUNNER_PER_MINUTE`, default 1200).
- A wrong registration token on `/runner/register` is a 401 (was 400), so it counts toward the per-address authentication-failure limit like a wrong runner token.
- Tests: e2e with the real `RunnerAuthGuard` and database: two runners on one IP each get `RateLimit-Limit: 1200` and their own window; 40 runner calls leave the address's anonymous window untouched; wrong runner tokens → 401 → 429 after the auth-failure limit while the real runner keeps working. Verified live (heartbeat answers `RateLimit-Limit: 1200`). API 164/164.
- Note: this drop also carries the start of managed runners (migration 0043 adds `runner_pools.managed`, `MANAGED_RUNNER_SECRET` env, optional `managedSecret` in the register DTO); nothing uses them yet.

## Rate limits: failed authentication counted; CLI 429 handling in login; usage error message — CLI 2.16.1
- Failed authentication was never limited: the guards reject a bad token (401) or a forbidden call (403) before the rate-limit interceptor runs, and `/registry/token` was exempt, so bearer-token and docker-login password guessing were unlimited. The global exception filter now counts every 401 per client IP in a new class `authFailures` (`RATE_LIMIT_AUTH_FAILURES_PER_MINUTE`, default 30) — on every path, including `/registry/token`, webhooks and `/registry/events` — and answers 429 + `Retry-After` past the limit ("Too many failed authentication attempts from this address"). Requests that authenticate are unaffected. 403s count against the caller's own read / write bucket. Successful registry token, webhook and events requests are still never counted.
- Fix (previous drop): the usage route lived in `usage.module.ts`, which the UI ⇄ API ⇄ CLI parity guard does not scan; moved to `usage.controller.ts` (the parity spec failed in 2.16.0).
- CLI: `matelot login` token exchange and the automatic token refresh honour 429 + `Retry-After` (≤ 60 s, up to 3 retries; the authorization code is not consumed by a refused request). `matelot usage` (and any command needing the default organization) reports "cannot reach …" when the API is down instead of "--org is required"; a token that may not list organizations says so and suggests `--org`.
- Tests: e2e auth-failure spec on a real Nest app (30 bad tokens → 401, 31st → 429 with Retry-After, good token from the same IP → 200, other IPs unaffected; 50 good registry-token requests not limited, failed basic auth + webhook signature failures share the address window; 403s on the caller's bucket); CLI retryingFetch (waits, max 3, > 60 s gives up), refresh after a 429, API-down usage message. Verified live with the default limit of 30. API 162/162, CLI 32/32, web green.

## M12 slice 1 — rate limits and usage metering (migration 0042) — CLI 2.16.0
- Rate limits: `RateLimitInterceptor` (after the guards, so the caller is known): fixed one-minute windows per user / CI token (reads and writes separately), per runner, and per client IP for unauthenticated calls; defaults 1200 read, 300 write, 1200 runner, 120 anonymous per minute (`RATE_LIMIT_*`, 0 = unlimited, `RATE_LIMIT_ENABLED=false`). Counters in Redis shared across replicas (no offline queue, one try; falls back to per-process counting and logs once per outage). Exempt: health, webhooks, registry token/events, `/.well-known`. `RateLimit-Limit/-Remaining/-Reset` headers; 429 with `Retry-After` and a message naming the class and limit.
- Usage metering: `usage_active_users` (a person is active for a month on their first authenticated request — not CI tokens or runners) and `usage_snapshots` (per organization and month, `final` once the month is over). `UsageService.compute`: active seats / members (membership anywhere in the organization tree, not disabled), projects, services, environments, pipelines, finished jobs, runner minutes (total and per job type), SBOMs. Worker snapshots every organization hourly and finalises the previous month. `GET /organizations/:id/usage?month=&format=csv` (`audit:read`): live current month, stored past months, 12-month history, CSV export.
- Web: Organization → **Usage** — KPI tiles, month picker, runner minutes by job type, history table, Download CSV.
- CLI: `matelot usage [--month YYYY-MM] [--format csv] [--json]` (short report + history); 429 is retried after `Retry-After` (≤ 60 s, up to 3 times; safe for writes because the request was refused before running).
- Docs: `docs/usage-and-limits.md`; `.env.example` rate-limit settings.
- Tests: API rate-limit spec (classification, exemptions, headers + 429, per-caller isolation, disabled / 0 limits, window reset, Redis unreachable → no hang, logged once), usage spec (seats with multi-membership / disabled / other org / other month, archived projects excluded, runner minutes across a month boundary, platform jobs, snapshots finalised and served, history, CSV); web render test for /usage; CLI usage report / --month / CSV / --json and 429 retry (write) / give-up. Verified live: 5-request read limit → 429 with Retry-After; two stores on one Redis share a window; worker snapshots written. API 159/159, CLI 29/29, web green.

## Registry logos follow the cloud, whatever the auth
- `providerBrand(provider, authType, host)`: AWS ECR / Google Artifact Registry / Azure Container Registry logos for stored-secret (`aws`/`gcp`/`azure`) and keyless (`aws_wif`/`gcp_wif`/`azure_wif`) connections, and for token / basic logins to an ECR, ACR or GAR host (recognised from the registry host). Keyless connections used to show the Docker logo.
- Same rule for the connection description ("Azure Container Registry · … · keyless …" instead of "Container registry") and the per-cloud counters on the Connections page (keyless connections were counted as generic registries).
- Tests: web brand matrix (12 cases) and the keyless ACR manager showing the ACR logo; web 78 checks.

## Fix: Entra error cleanup left "orrelation ID: …"
- `cloudError()` stripped diagnostics with a loose class (`[0-9a-fA-F:\-TZ. ]+`) that includes `C`, so after a Trace ID it ate the "C" of "Correlation ID" and left "orrelation ID: <guid>". Each diagnostic is now matched by its exact shape — `Trace ID` / `Correlation ID` / `Request Id` + GUID, `Timestamp` + date-time (fractional seconds, optional Z) — removed whole, in any order.
- The message ends at its last sentence: a fragment-shaped tail (label remnant, bare id, a few characters) is dropped; a trailing docs URL and a real trailing clause without a full stop are kept.
- Tests with the real AADSTS70025 string (exact expected output, shuffled order), AADSTS700213 (hint and docs link kept whole), a non-diagnostic subject GUID, a meaningful tail clause. API 150/150.

## Connection delete / disconnect, keyless status and readable cloud errors — CLI 2.15.0
- `DELETE /integrations/:id` deletes (was: marked disconnected unless `?permanent=true`): the connection, its repositories and their service links. Container images that pull through it → 409 with the list (`images`); `force=true` (query or body) detaches them (integrationId → null). Response `{ deleted, repositories, imagesDetached }`. New `POST /integrations/:id/disconnect` keeps the row and repositories and forgets the credentials. CLI: `connection delete [--force]`, new `connection disconnect`; web: Disconnect uses the new route, Delete shows the 409 with "Detach images and delete".
- Keyless connections keep their non-secret parameters in `settings.keylessParams` (provider/serviceAccount, roleArn/region, tenantId/clientId) — set at create, backfilled at verify and disconnect. A disconnected keyless connection's identity returns `disconnected: true` and the real values; the web shows only "Disconnected — create the connection again" (no steps, no Verify; Manage no longer opens on Identity for it).
- Verify clears `settings.pendingReason`. `SourceSyncService.markHealthy` (source sync and now image sync) sets `connected`, `lastSyncedAt`, clears `lastError` and `pendingReason`; never for disconnected or unverified keyless connections. Image syncs and registry lookups by host skip disconnected / unverified keyless connections.
- CLI: `connection verify` / `delete` / `disconnect` print one summary line ("verified: …", "deleted … (N repositories removed; images detached: …)", "disconnected …"); JSON only with `--json`.
- Cloud errors: `cloudError()` parses Entra / Google OAuth `{error, error_description}`, Google APIs `{error:{status,message}}`, AWS XML `<Code>/<Message>`, ECR `{__type,message}`, registry `{errors:[…]}`; drops Trace / Correlation / Request ids and timestamps; keeps up to ~500 chars, cut at a word boundary. Used for every STS / Entra / ACR / ECR / GCP exchange and registry token refusals.
- Tests: API `connection-lifecycle.spec.ts` (409 + force delete with repository and service link, plain delete, disconnected keyless identity with real clientId, pendingReason cleared on verify, connected after first sync, never for unverified / disconnected; cloud error parsing for Entra, AWS, Google, ECR, registry, long text); web `keyless-verify.mjs` (+ disconnect route, 409 → force, disconnected panel); CLI `keyless.test.ts` (summary output, `--json`, delete 409 / `--force`, disconnect). API 147/147, web 65 checks, CLI 27/27.

## Keyless connections: create first, verify with the real subject — CLI 2.14.0
- Fix: creating a keyless (gcp_wif / aws_wif / azure_wif) connection probed the registry before the row existed and signed a token with `sub=integration:pending`, so any trust pinning the documented subject rejected creation. Keyless connections are now inserted first (`pending`, `settings.verified=false`, `keyless=true`), with no probe and no sync, and the create response carries `identity` (issuer, subject, audiences, steps).
- `POST /integrations/:id/verify` works for registry connections (was git only): probes with the stored credentials and the real connection id; success sets `verified`, `verifiedAt`, `account`, clears `lastError` and starts the sync; failure stores `lastError` (audit `integration.verify_failed`). Other providers get a clear 400.
- The token issuer refuses placeholder subjects (anything that is not a connection id) before any cloud call. `POST /integrations/test` explains that keyless connections are checked after creation. Syncing an unverified keyless connection is a quiet no-op.
- Identity setup is concrete per connection: GCP principal from the stored provider path (+ `gcloud … add-iam-policy-binding`), AWS OIDC provider ARN and the full trust policy JSON (condition keys = issuer host + path), Azure `az ad app federated-credential create` with the exact subject; `verified`, `verifiedAt`, `lastError` returned.
- Web: shared `KeylessIdentity` panel with verification state and a **Verify** button — in Manage → Identity (opened by default while unverified) and in the connect wizard's last step for keyless connections; "Test connection" replaced by an explanation for keyless; Manage → Actions has Verify for every registry connection. The "go keyless" text no longer points to a non-existent update command.
- CLI: `connection create` for keyless prints the subject to trust and the verify command (stderr; `--json` stays pure); `connection verify --id` works for registries and prints the verified account.
- Tests: API `keyless-verify.spec.ts` (ECR, GAR, ACR: no token at create, verify refused until the cloud trusts `integration:<id>`, then verified and synced; test endpoint; quiet sync; provider guard) and a placeholder-subject test; web `test/keyless-verify.mjs` (Identity tab default, exact subject, refusal shown, Verify → Verified); CLI `keyless.test.ts`. API 139/139, web 57 checks, CLI 26/26.

## Keyless registry connections — workload identity federation (migration 0041) — CLI 2.13.0
- The platform is an OIDC issuer: `/.well-known/openid-configuration` and `/.well-known/jwks.json` (public, outside `/api/v1`). RS256 signing key stored encrypted with the cell key (`signing_keys` table); rotated if undecryptable, retired keys stay in the JWKS. Tokens live 10 min, `sub = integration:<id>`.
- New auth types `gcp_wif` (GAR: STS exchange → service-account access token), `aws_wif` (ECR: AssumeRoleWithWebIdentity → temporary keys), `azure_wif` (ACR: Entra client assertion → ACR refresh token). No secret stored. Used by verify, sync, image pulls in the API and worker.
- `GET /integrations/:id/identity` returns issuer, subject, audiences and per-cloud setup steps, with a warning when `API_PUBLIC_URL` is not public HTTPS.
- Web: Connect wizard "Keyless" toggle for GAR/ECR/ACR (provider + service account / role ARN / tenant + client id, no secret fields); Manage → "Identity · keyless" tab with copyable values and steps.
- CLI: `matelot connection identity --id <connection>`.
- Docs: `docs/keyless-registries.md`; `.env.example` notes `API_PUBLIC_URL` must be public HTTPS for keyless.
- API and worker serialise key creation/rotation with an advisory lock (one active key even when both boot at once); a warning is logged when `API_PUBLIC_URL` is unset.
- Tests: `identity.spec.ts` (JWKS verification, key rotation, concurrent boot, mocked GCP/AWS/Azure exchanges, missing issuer). API suite 132/132.

## Fixes after the SAST/SCA and OAuth test rounds (5 Oct) — CLI 2.12.0
- CLI: `job logs` renders `at / stream / content` (was an empty `line` column). Policy flags `--environments`, `--enforce`, `--max-sast` map on create / create-project / update; rule flags send only the rules given (the API merges on PATCH); **unknown flags are an error**. `pipeline --wait --json` prints JSON only (progress on stderr). Gate line shows `iac N · sast N`. `login`: browser openers tried in order ($BROWSER, open/start, xdg-open, wslview, sensible-browser, x-www-browser) with the error event handled — no opener just prints the link; `--no-browser`; a stale-state callback is answered 400 and the login keeps waiting.
- Policies: `normalizeRules` — a missing/null rule means "no limit", booleans default; applied on create, merged on update, and at evaluation (older rows); violation text never says `undefined`. `--ref` subjects evaluate with the newest source SBOM of the service (dependency rules) and code rules need no image.
- SAST job: default rules `p/security-audit,p/secrets` (comma-separated packs allowed; `auto` on request); the job log states the config, matched rules and files scanned. Titles truncate at a word boundary with "…"; a bare autofix token is rendered in context ("shell=False (instead of shell=True)") or omitted.
- Web: the OAuth consent page renders in a minimal layout (logo + card; no sidebar or workspace selector).
- Tests: CLI logs rendering, per-flag policy mapping, unknown flag, JSON purity, opener fallback, stale-state callback; gate with partial rules; runner title/fix cosmetics; consent layout.

## Pipeline: `dependencies` (sca) and `code` (sast) jobs are real
- `sca`: the runner asks the platform to correlate the service's SBOMs now (`POST /runner/jobs/:id/correlate`, waits for the run) and logs the pipeline SBOM's open vulnerabilities (unique per advisory/source package, plus package count). Was "skipped" by design.
- `sast`: Semgrep in the runner image (`semgrep==1.97.0`; rules from `payload.config` / `SEMGREP_CONFIG`, default `auto`, offline packs such as `p/ci` work without network). Findings become code findings of kind `sast` (severity from the rule's security-severity → impact → ERROR/WARNING/INFO; CWE references; stable fingerprint), with the same decisions, exceptions, SLAs and remediation flow as secrets / IaC. Was "not available in this runner version".
- Policies: new rule `maxSastSeverity` (`max_sast_severity` violation); CRA baseline blocks ≥ high, Production baseline ≥ critical; editor row "Code findings (static analysis) at or above"; CLI `policy create --max-sast SEV`. Gate facts carry `sastOpen`.
- Code findings panel: "Code (SAST) · critical/high" KPI. Runner parser test (`code-scan.test.ts`), gate rule test.

## Platform job loop hardened (migration 0040)
- `WorkerService.runPlatformJobsOnce()`: runs immediately at start (jobs queued while the worker was down), then every 5 s; an overlap guard prevents passes piling up behind a slow evaluation; each job is claimed atomically (`queued → running` only if still queued, so two passes / two worker instances never double-run); every failure is logged (`platform job … failed`, `platform job loop failed`); a job queued > 2 min is logged once when picked up.
- `platform_heartbeats` table: the loop writes `platform-worker` every pass; pipeline / job detail return `platformWorkerSeenAt`; the UI says "Waiting for the platform worker (last seen N min ago / not running?)" for policy_eval jobs instead of "Waiting for a runner".
- DB test: a queued `__platform__` job is claimed and finished within one pass; two concurrent passes run it once; the heartbeat is written.

## Exceptions: pending state; consent never silently narrower; CLI help without credentials (CLI 2.11.2)
- Exceptions created by a non-approver are `state: pending` (not applied, findings stay open) until `POST /exceptions/:id/approve` by an approver makes them `active` and applies them. `exceptions list` and the Exceptions panel show *pending approval* with Approve / Withdraw; `applied` is 0 while pending. DB test covers the full state machine.
- OAuth consent: the selected scope defaults to what the app requested; the Administrator card is shown to platform administrators when sudo is requested; non-administrators see a notice that the grant will be narrower. `matelot login` warns "granted write, not sudo" when the granted scope is below the requested one (`narrowed: true` in `--json`).
- `matelot <resource> <verb> --help` prints the route, fields and path flags without needing credentials.

## Exceptions get their own permission; token-scope matrix aligned with the consent page
- New permissions `exception:write` (request / create, revoke) and `exception:approve`; exception routes no longer require `policy:write`. An exception created by a non-approver is pending until approved (`POST /exceptions/:id/approve` needs `exception:approve`). Granted alongside the previous `policy:exception_request` / `_approve`: PRODUCT_SECURITY_ENGINEER, TEAM_LEAD, DEVELOPER can request; SECURITY_ADMIN, COMPLIANCE_OFFICER, CISO, ORG_ADMIN approve.
- PRODUCT_SECURITY_ENGINEER can run / cancel pipelines (the `write` token promised it).
- Consent page copy rewritten to the exact matrix; `docs/roles.md` documents roles and the scope × action table; `matelot_start_here` mentions the scope rule. `apps/api/src/rbac/token-scope-matrix.spec.ts` asserts the table (read/write/sudo × 10 actions) so copy and RBAC cannot drift.
- CLI: `membership grant` help lists the valid roles.

## Fix: non-sudo tokens of administrators; CLI credentials (migration 0039, CLI 2.11.1)
- `AccessService.forUser`: a personal / OAuth token without sudo no longer drops `ORG_ADMIN` / `SECURITY_ADMIN` memberships (which left an admin's `write` token with no permissions at all). They are **downgraded** instead: `read` → AUDITOR, `write` → PRODUCT_SECURITY_ENGINEER, on every scope the user can see; a cell administrator without memberships gets the same downgraded view of every organization. Sudo is unchanged. DB test: ORG_ADMIN + write token reads findings and decides, cannot administer; read token is read-only.
- OAuth-issued tokens: created through the same code path as UI tokens, named after the client ("matelot CLI", "claude.ai"), `source = oauth` + `oauth_client_id` (0039), audited as `personal_token.created`; Account → Access tokens shows an *oauth* badge.
- CLI: credentials stored as `{accessToken, refreshToken, expiresAt (ISO), scope}` (old snake_case files still read), `expires_in` parsed defensively, lazy refresh before expiry, `matelot logout` revokes the refresh token at the server. Tests assert the stored file after login, refresh after expiry, and revocation.

## Fix: `matelot login` approve failed on a foreign key (migration 0038)
- The built-in client `matelot-cli` is a real `oauth_clients` row (seeded by 0038 and ensured at boot / on first use), so codes and refresh tokens can reference it. Loopback-only redirects stay enforced for it (and for any client whose `redirect_uris` carries the `loopback` marker). DB test: authorize → approve → token for `matelot-cli` end to end.

## Fix: OAuth consent survives a sign-in round trip
- `onSigninCallback` rewrites the Keycloak callback URL to `returnTo` (path + query) before the router renders, so the index redirect never strips it; `RequireAuth` keeps the splash while `?code&state` are in the URL and navigates to `returnTo` itself as a fallback. New web test `test/oauth-consent-flow.mjs`: anonymous visit to `/oauth/consent?…` → sign in → consent page.

## OAuth 2.1 (migration 0037) — claude.ai connectors, `matelot login`
- Authorization server in the API: discovery (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource[/api/v1/mcp]`), dynamic client registration (public clients + PKCE S256), `GET /oauth/authorize` → web consent page (`/oauth/consent`: read-only / read & write / administrator), `POST /oauth/approve` (session), `POST /oauth/token` (authorization_code, refresh_token with rotation; form or JSON), `POST /oauth/revoke`. Access tokens ARE personal access tokens (24 h) — same RBAC, audit and revocation; refresh tokens 30 days.
- `/api/v1/mcp` answers 401 with `WWW-Authenticate: Bearer resource_metadata=…`, so MCP clients find the OAuth server.
- `API_PUBLIC_URL` (issuer; defaults to `http://localhost:PORT`). `express` is now a direct dependency (form-encoded token requests).
- CLI 2.11.0: `matelot login --url … [--scope]` (loopback redirect + PKCE, credentials in `~/.config/matelot/credentials.json`, lazy refresh), `matelot logout` (revokes). Env credentials still take precedence (CI unchanged).

## Registry login with personal tokens; manual tracker sync; fixedIn
- Built-in registry: `docker login -u token -p spt_…` (what `matelot registry login` does with `MATELOT_TOKEN`) is accepted; access follows the user's RBAC per repository (`registry:pull` / `registry:push`), push into a protected environment repository needs a sudo token. `PersonalTokensService` moved into a global `PersonalTokensModule`.
- `POST /organizations/:id/remediations/sync-trackers` and `matelot remediations sync-trackers`: run the inbound Jira/GitHub/GitLab sync now.
- `GET /sboms/:id/findings` adds `fixedIn` (the version of the first later image SBOM that no longer links the finding) for service-level-fixed findings; `inThisSbom` reads "affected — fixed in 1.0.23".

## Per-SBOM / per-release views scope by membership, not by service-level status
- `GET /sboms/:id/findings` returns every finding linked to the SBOM (default: all statuses) with `serviceStatus` and `inThisSbom` ("affected" / "affected — fixed in a later build").
- Container images SBOM counts and "Running now" include service-level `fixed` findings for the SBOM that contains them (decided ones — accepted / false positive / not affected — stay excluded).
- Evidence summary tags each finding with `versionStatus`; the release VEX emits an **`affected`** statement (not nothing) for a finding fixed at service level later: action_statement "Affected in this version; no longer present in later builds (fix X)", status_notes with the date. `fixed` statements remain only for the previous-release diff.

## Container images view: one view for UI, CLI and MCP; release by digest
- `GET /services/:id/images` returns the same annotated tags as the web app (warnings always an array, release, SBOM, environments).
- Release identity comes from version/commit tags only (`isReleaseTag`); environment and floating tags (`preprod`, `latest`, `sha256-…`) are attributed **at read time to the release whose version tag carries their digest**, never persisted. A floating tag that moves digest drops its old link on sync. Fixes stale `prod → 1.0.9` links and the false `rebuilt_commit` on every 1.0.25 tag.
- `rebuilt_commit` is computed from version/commit tags only.
- SBOM counts per tag are that SBOM's own findings, unique (canonical advisory, source package), with the advisory×package total as `packages` (shown as "· N package findings").
- `replaceDigestPlaceholders` also removes placeholder rows that no deployment references and no real tag explains.

## Tracker sync (inbound) and registry / build warnings
- Hourly `syncFromTrackers`: an issue closed in Jira (done category), GitHub or GitLab marks its remediation `done` (note "closed in jira (Done)", audit `remediation.updated` with `source: tracker:…`); an issue reopened in the tracker while the remediation has been done for > 10 min reopens it. Each remediation is isolated; tracker errors are logged.
- Inventory → Container images: tag warnings. `unaccepted_tag`: a tag named after an environment whose digest is not what that environment runs (rejected deployment / push without deployment) — red chip. `rebuilt_commit`: a release built more than once with different digests — amber chip. Both returned by the API (`tags[].warnings`).

## Issue trackers: Jira / GitHub follow-ups
- Jira descriptions are real ADF (bold labels, links, lists) instead of literal Markdown; `priority` from severity (critical→Highest … low→Low) and `duedate` from the SLA, dropped automatically when the project's screen lacks them.
- Remediation status is mirrored to the tracker: done / won't fix → Jira transition to a done-category status (found via /transitions) or GitHub/GitLab close, with a comment; open / in progress after done → reopen. Best effort: failures are logged (`remediation.issue_synced` audit on success), never block the change.
- `remediation create` returns 409 `remediation_exists` (with the existing id and issue key) when an active remediation for the same service + advisory + component exists; `--force` / `force: true` creates another.

## CLI 2.10.0 — parity with the web app
- 45 new resource commands so every UI action has a `matelot` command: team/project/service/workspace/environment create·update·delete, env settings & kubernetes-sync, connection create·test·verify·sync·delete·link-installation·create-ecr-repository, repository attach·detach, releases sync, image delete, policies at workspace/team (create, from-template), runner-pool create·delete·registration-token, runner delete, membership revoke, organization create·update, risk recompute-project, findings snapshot, job retry·cancel, pipeline cancel, admin update-user.
- `--body '{...}'` on every resource command (raw JSON merged last; nested fields such as `auth` exactly as the web app sends them); new path flags `--workspace`, `--team`.
- `CUSTOM_COMMANDS` manifest for hand-written commands (gate, deploy, promote, pipeline, sbom, release create, registry login/path, apply, recorrelate, evidence verify).
- Guard: `apps/api/src/parity.spec.ts` fails the build when a mutating route has no CLI command or a web-app call targets an undocumented route. `docs/parity-matrix.md` (generated), `docs/cli-reference.md` (generated).

## API (migration 0036) / CLI
- Fix: ACR tag digests (root cause). `RegistryClient` cached the first challenge token and never re-challenged while one existed; ACR scopes tokens per operation (`metadata_read` for tags/list, `pull` for manifests), so manifest reads got a silent 401. Tokens are now cached per scope and a 401 re-runs the challenge for the scope the registry names. Unresolved digests are written to the image's `lastError` ("digest unresolved for N tag(s): …") and logged.
- Fix: ACR tag digests. `RegistryClient.digest()` could throw on ACR's HEAD responses, so the sync stored null without a trace. `digestWithReason()` never throws: HEAD with every manifest media type → GET header → sha256 of the manifest bytes, and the sync logs the reason whenever a digest cannot be resolved (keeping any known digest).
- Environments view: a deployment attached to a digest placeholder shows the real tag of that digest in the same image (the environment's own tag, then a version-like tag, then any); the placeholder is only a fallback.
- Failed SBOM correlations are retried automatically with exponential backoff (1, 2, 4 … 60 min; `correlation_attempts`, `correlation_next_retry_at`); the periodic loop runs every 30 s; a gate that waits retries a failed SBOM immediately. `awaitCorrelation(id, 0)` still reports `failed` for evaluate-now calls.
- CLI: `matelot image sync --service ID --id IMAGE` calls `POST /services/:service/images/:id/sync` (was an unscoped path → 404).

## API (migration 0035)
- Fix: images registered from a deployment (or the backfill) had no registry connection, so private registries (ACR) were never listed and deployments kept a `sha256-<12>` placeholder tag. `syncImage` now attaches the connection by host (nearest on the service's chain); after a sync, placeholders are replaced by the real tag of the same digest (version-like tag preferred) and removed.
- Fix: the duplicate-finding merge updated `remediations.finding_ids` (text[]) with uuid parameters and aborted every correlation run (gates stuck on PENDING). The rewrite is now done in application code, runs after the kept finding exists, and is isolated: a bookkeeping failure is logged and the SBOM still reaches `done`.
- Deployments get a tag row in the image their `imageRef` names (created from tag/digest when the registry is not synced yet); a same-digest row of another registry is never borrowed. Existing borrowed rows are re-pointed once after start (`repointBorrowedDeployments`).
- Advisories are canonicalised by CVE (`canonical_id`: lowest CVE alias, else the record id). One finding per (component, canonical) — duplicates (GHSA + PYSEC + DEBIAN-CVE of one CVE) are merged into the strongest record, remediations re-pointed, an audit event `finding.merged` written. All unique counts, risk and the VEX key on the canonical id; VEX statements are named by the CVE and list every record id as an alias.

## CLI 2.9.0 / API (migration 0034)
- Gate: an image subject (`--image …@sha256` or a tag) is scored only by the SBOM of that exact digest; no version/release fallback (it once scored a clean build with a rebuilt sibling's critical). Without an SBOM the result is pending (exit 3). Evaluations now record `subject.evaluatedDigest`, `subject.sbomDigest` and the version derived from the tag's release.
- `gate` and `deploy` wait for the image's SBOM and its correlation (`--wait-correlation N`, default 300 s in CI, 0 interactively), in ≤ 25 s server slices.
- New exit code `3` = not evaluated (no SBOM yet / correlation pending or failed); no partial counts are printed.
- **Breaking:** authentication failure exits `4` (was `3`).
- Migration 0034 backfills SBOMs from before correlation tracking to `done`, so gates on older images do not wait.
