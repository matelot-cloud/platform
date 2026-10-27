#!/usr/bin/env bash
# cell-provision.sh without a cluster: `new` writes the values file from the template, and preflight's values reader
# (values_get) parses what `new` wrote — including the inline comment on the issuer line that once made preflight look
# up the ClusterIssuer "selfsigned   # letsencrypt in production; …". Runs with PyYAML and with the fallback parser.
# Run: bash scripts/cell-provision.test.sh
set -euo pipefail
cd "$(dirname "$0")/.."
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
# work on a copy of the repo's deploy/cells so the real folder stays untouched; a fake kubectl answers the kind context
mkdir -p "$T/bin" "$T/repo/scripts/lib" "$T/repo/deploy/cells"
cp scripts/cell-provision.sh "$T/repo/scripts/"; cp scripts/lib/wait.sh scripts/lib/split-hooks.py scripts/lib/values-image-tag.py "$T/repo/scripts/lib/"; cp deploy/cells/_template.values.yaml "$T/repo/deploy/cells/"
printf '#!/usr/bin/env bash\n[ "$1 $2" = "config current-context" ] && { echo "${FAKE_CONTEXT:-kind-secops}"; exit 0; }\nexit 1\n' > "$T/bin/kubectl"; chmod +x "$T/bin/kubectl"
export PATH="$T/bin:$PATH"
cd "$T/repo"

# 1. new on the kind context → selfsigned; on another context → letsencrypt; --issuer wins
bash scripts/cell-provision.sh new --slug acme --name "ACME Corp" --domain platform.local --admin "ciso@acme.local, sec@acme.local" | grep -q "issuer: selfsigned" || { echo "FAIL: new on kind should pick selfsigned" >&2; exit 1; }
FAKE_CONTEXT=prod-eu bash scripts/cell-provision.sh new --slug globex --name Globex --domain example.com --admin a@globex.com | grep -q "issuer: letsencrypt" || { echo "FAIL: new elsewhere should pick letsencrypt" >&2; exit 1; }
bash scripts/cell-provision.sh new --slug initech --name Initech --domain example.com --admin a@initech.com --issuer my-ca | grep -q "issuer: my-ca" || { echo "FAIL: --issuer" >&2; exit 1; }
grep -q 'cert-manager.io/cluster-issuer: selfsigned   #' deploy/cells/acme.values.yaml || { echo "FAIL: the template's inline comment is gone (the test needs it)" >&2; exit 1; }
grep -q 'adminEmails: \["ciso@acme.local","sec@acme.local"\]' deploy/cells/acme.values.yaml || { echo "FAIL: admins" >&2; exit 1; }

# 2. values_get on that file, with PyYAML and with the fallback parser (PyYAML hidden behind a stub that fails to import)
# the values reader, extracted from the script (it is a function of cell-provision.sh, not a library)
sed -n '/^values_get()/,/^}/p' scripts/cell-provision.sh > "$T/values_get.sh"
# shellcheck disable=SC1091
source "$T/values_get.sh"
export VALUES=deploy/cells/acme.values.yaml
check() { # check <label>
  local got
  got="$(values_get ingress annotations cert-manager.io/cluster-issuer)"; [ "$got" = selfsigned ] || { echo "FAIL ($1): issuer parsed as [$got]" >&2; exit 1; }
  got="$(values_get ingress tls)"; [ "$got" = true ] || { echo "FAIL ($1): tls parsed as [$got]" >&2; exit 1; }
  got="$(values_get tenant domain)"; [ "$got" = platform.local ] || { echo "FAIL ($1): domain parsed as [$got]" >&2; exit 1; }
  got="$(values_get ingress className)"; [ "$got" = nginx ] || { echo "FAIL ($1): className parsed as [$got]" >&2; exit 1; }
  got="$(values_get tenant name)"; [ "$got" = "ACME Corp" ] || { echo "FAIL ($1): quoted name parsed as [$got]" >&2; exit 1; }
  got="$(values_get nothing here)"; [ -z "$got" ] || { echo "FAIL ($1): missing key should be empty, got [$got]" >&2; exit 1; }
}
python3 -c 'import yaml' 2>/dev/null && check "pyyaml" || echo "(PyYAML not installed: only the fallback parser is tested)"
mkdir -p "$T/noyaml"; printf 'raise ImportError("hidden for the test")\n' > "$T/noyaml/yaml.py"
PYTHONPATH="$T/noyaml" check "fallback"

# 3. checks: restarts of terminating pods and of pods of a scaled-down ReplicaSet (the old api pod after an upgrade)
#    are not reported; a restarting pod of the current ReplicaSet is
sed -n '/^restart_report()/,/^}/p' scripts/cell-provision.sh > "$T/restart_report.sh"
# shellcheck disable=SC1091
source "$T/restart_report.sh"
tab=$'\t'
report="$(printf '%s\n' \
  "acme-api-old-x1${tab}3${tab}Error${tab}2026-10-15T09:00:00Z${tab}2026-10-14T08:00:00Z${tab}2026-10-15T10:00:00Z${tab}ReplicaSet${tab}acme-api-6d9f" \
  "acme-api-old-x2${tab}2${tab}OOMKilled${tab}2026-10-15T09:10:00Z${tab}2026-10-14T08:00:00Z${tab}${tab}ReplicaSet${tab}acme-api-6d9f" \
  "acme-api-new-y1${tab}1${tab}Error${tab}2026-10-15T10:05:00Z${tab}2026-10-15T10:01:00Z${tab}${tab}ReplicaSet${tab}acme-api-7b2c" \
  "acme-postgres-0${tab}0${tab}${tab}${tab}2026-10-14T08:00:00Z${tab}${tab}StatefulSet${tab}acme-postgres" \
  | restart_report "acme-api-6d9f,acme-worker-55aa,")"
grep -q "restarts: acme-api-new-y1 1 (last: Error" <<< "$report" || { echo "FAIL: the current pod's restart is missing: $report" >&2; exit 1; }
grep -q "acme-api-old" <<< "$report" && { echo "FAIL: terminating / replaced pods reported: $report" >&2; exit 1; }
grep -q "(2 terminating or replaced pods not counted)" <<< "$report" || { echo "FAIL: skipped pods not mentioned: $report" >&2; exit 1; }
grep -q "postgres" <<< "$report" && { echo "FAIL: a pod without restarts reported" >&2; exit 1; }

# 4. the readiness probe: the sh loop the curl pod runs, with a fake curl that refuses twice then answers 200, and one
#    that never answers; then the report lines built from that output
sed -n '/^readiness_script()/,/^}/p; /^readiness_report()/,/^}/p' scripts/cell-provision.sh > "$T/readiness.sh"
# shellcheck disable=SC1091
source "$T/readiness.sh"
mkdir -p "$T/probe"; printf '0' > "$T/probe/calls"
cat > "$T/bin/curl" <<'FAKE'
#!/usr/bin/env bash
# fake curl: -o FILE -w FORMAT URL; the first PROBE_FAILS calls refuse the connection (exit 7, status 000), then 200
n=$(cat "$PROBE_DIR/calls"); n=$((n+1)); printf '%s' "$n" > "$PROBE_DIR/calls"
out=""; while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift;; esac; shift; done
if [ "$n" -le "${PROBE_FAILS:-0}" ]; then echo "curl: (7) Failed to connect to globex-api port 80: Connection refused" >&2; printf '000'; exit 7; fi
printf '{"status":"ok"}' > "$out"; printf '200'
FAKE
chmod +x "$T/bin/curl"
export PROBE_DIR="$T/probe"
out="$(PROBE_FAILS=2 sh -c "$(readiness_script)" probe http://globex-api:80/api/v1/health/ready 60)"
grep -q '^attempt 1 (0s): HTTP 000 curl: (7) Failed to connect' <<< "$out" || { echo "FAIL: first attempt not reported: $out" >&2; exit 1; }
grep -qE '^READY 3 [0-9]+$' <<< "$out" || { echo "FAIL: no READY after two refusals: $out" >&2; exit 1; }
report="$(readiness_report http://globex-api:80/api/v1/health/ready "$out")" || { echo "FAIL: report should pass" >&2; exit 1; }
grep -q '→ 200 after [0-9]*s and 3 attempts (the first 2 got no answer' <<< "$report" || { echo "FAIL: report: $report" >&2; exit 1; }
printf '0' > "$T/probe/calls"
out="$(PROBE_FAILS=0 sh -c "$(readiness_script)" probe http://globex-api:80/api/v1/health/ready 60)"
grep -qE '^READY 1 [0-9]+$' <<< "$out" || { echo "FAIL: immediate 200: $out" >&2; exit 1; }
grep -q '→ 200 (ready in [0-9]*s)' <<< "$(readiness_report http://x "$out")" || { echo "FAIL: ready-in line" >&2; exit 1; }
printf '0' > "$T/probe/calls"
out="$(PROBE_FAILS=99 sh -c "$(readiness_script)" probe http://globex-api:80/api/v1/health/ready 3 || true)"
grep -qE '^FAILED [0-9]+ [0-9]+ 000$' <<< "$out" || { echo "FAIL: no FAILED after the timeout: $out" >&2; exit 1; }
if readiness_report http://x "$out" 2> "$T/report.err"; then echo "FAIL: report should fail" >&2; exit 1; fi
grep -q 'no 200 in [0-9]*s ([0-9]* attempts); last: HTTP 000' "$T/report.err" || { echo "FAIL: failure report: $(cat "$T/report.err")" >&2; exit 1; }
grep -q 'Connection refused' "$T/report.err" || { echo "FAIL: the last error is not shown" >&2; exit 1; }
# a probe pod that gives NO verdict (empty output: kubectl run lost its attach right after a rollout) is a retry inside
# the budget, not "unhealthy"; when it persists, the last pod's phase, last event and logs are printed
sed -n '/^probe_cell()/,/^}/p' scripts/cell-provision.sh > "$T/probe_cell.sh"
# shellcheck disable=SC1091
source "$T/probe_cell.sh"
RELEASE=globex
printf '0' > "$T/probe/runs"
probe_run() { # stub: NO_VERDICT_RUNS empty outputs, then READY
  local n; n=$(cat "$T/probe/runs"); n=$((n+1)); printf '%s' "$n" > "$T/probe/runs"
  if [ "$n" -le "${NO_VERDICT_RUNS:-0}" ]; then printf ''; else printf 'READY 1 0\n'; fi
}
report="$(NO_VERDICT_RUNS=2 probe_cell http://globex-api:80/api/v1/health/ready 60 2>&1)" || { echo "FAIL: two empty probe pods then READY must pass: $report" >&2; exit 1; }
grep -q '→ 200 (ready in 0s)' <<< "$report" && grep -q 'the first 2 probe pod(s) gave no verdict' <<< "$report" || { echo "FAIL: $report" >&2; exit 1; }
[ "$(cat "$T/probe/runs")" = 3 ] || { echo "FAIL: expected 3 probe runs, got $(cat "$T/probe/runs")" >&2; exit 1; }
# persisting: a fake kubectl answers the diagnostics (phase, event, logs) for the kept pod
printf '0' > "$T/probe/runs"
cat > "$T/bin/kubectl" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  *"get pod"*jsonpath*) printf 'Pending';;
  *"get events"*) printf 'FailedScheduling: 0/3 nodes are available: insufficient memory';;
  *logs*) printf 'probe never started\n';;
  *delete*) :;;
esac
FAKE
chmod +x "$T/bin/kubectl"
K=(kubectl -n tenant-globex)
if NO_VERDICT_RUNS=99 probe_cell http://globex-api:80/api/v1/health/ready 10 > "$T/probe.out" 2> "$T/probe.err"; then echo "FAIL: persisting no-verdict must fail" >&2; exit 1; fi
grep -q 'the probe pod gave no verdict [0-9]* times in 10s' "$T/probe.err" || { echo "FAIL: $(cat "$T/probe.err")" >&2; exit 1; }
grep -q 'phase Pending; last event: FailedScheduling: 0/3 nodes' "$T/probe.err" || { echo "FAIL: diagnostics: $(cat "$T/probe.err")" >&2; exit 1; }
grep -q 'log: probe never started' "$T/probe.err" || { echo "FAIL: logs missing: $(cat "$T/probe.err")" >&2; exit 1; }

# 5. release_recoverable: what apply does with a release an earlier apply left failed / pending (fake helm on PATH)
sed -n '/^release_recoverable()/,/^}/p' scripts/cell-provision.sh > "$T/recover.sh"
# shellcheck disable=SC1091
source "$T/recover.sh"
export RELEASE=globex NAMESPACE=tenant-globex   # read by the sourced release_recoverable
cat > "$T/bin/helm" <<'FAKE'
#!/usr/bin/env bash
# fake helm: status → HELM_STATUS; history → HELM_HISTORY (tab-separated rows like the real one); rollback → recorded
case "$1" in
  status) printf '{"name":"globex","info":{"status":"%s"}}\n' "$HELM_STATUS";;
  history) printf '%b\n' "REVISION\tUPDATED\tSTATUS\tCHART\tAPP VERSION\tDESCRIPTION\n$HELM_HISTORY";;
  rollback) echo "rollback $*" >> "$HELM_LOG";;
esac
FAKE
chmod +x "$T/bin/helm"
export HELM_LOG="$T/helm.log"; : > "$HELM_LOG"
# history rows as `helm history` prints them: 7th field is the status
good_then_failed='1\tMon Oct 13 10:00:00 2026\tsuperseded\tsecops-cell-0.1.0\t0.1.0-rc.12\tUpgrade complete\n2\tMon Oct 19 09:30:00 2026\tfailed\tsecops-cell-0.1.0\t0.1.0-rc.13\tUpgrade "globex" failed'
HELM_STATUS=deployed HELM_HISTORY="$good_then_failed" release_recoverable > "$T/r.out" || { echo "FAIL: deployed must pass" >&2; exit 1; }
HELM_STATUS=failed HELM_HISTORY="$good_then_failed" release_recoverable > "$T/r.out" || { echo "FAIL: failed with a good revision must be upgradable" >&2; exit 1; }
grep -q "is 'failed' from an earlier apply (a good revision exists): upgrading over it" "$T/r.out" || { echo "FAIL: $(cat "$T/r.out")" >&2; exit 1; }
only_failed='1\tMon Oct 19 09:30:00 2026\tfailed\tsecops-cell-0.1.0\t0.1.0-rc.13\tInstall "globex" failed'
if HELM_STATUS=failed HELM_HISTORY="$only_failed" release_recoverable > "$T/r.out" 2> "$T/r.err"; then echo "FAIL: failed without any good revision must stop" >&2; exit 1; fi
grep -q "no revision ever deployed" "$T/r.err" || { echo "FAIL: $(cat "$T/r.err")" >&2; exit 1; }
pending='1\tMon Oct 13 10:00:00 2026\tsuperseded\tsecops-cell-0.1.0\t0.1.0-rc.11\tInstall complete\n2\tMon Oct 14 10:00:00 2026\tdeployed\tsecops-cell-0.1.0\t0.1.0-rc.12\tUpgrade complete\n3\tMon Oct 19 09:30:00 2026\tpending-upgrade\tsecops-cell-0.1.0\t0.1.0-rc.13\tPreparing upgrade'
HELM_STATUS=pending-upgrade HELM_HISTORY="$pending" release_recoverable > "$T/r.out" || { echo "FAIL: pending-upgrade with a good revision must roll back and pass" >&2; exit 1; }
grep -q "rollback globex 2 -n tenant-globex --wait --timeout 5m" "$HELM_LOG" || { echo "FAIL: expected a rollback to revision 2: $(cat "$HELM_LOG")" >&2; exit 1; }

# 5b. pin_tag: --tag is written into the values file (all four images); without --tag an existing release that runs
#     another tag than the file says is refused with both ways out; the same tag passes; a new release passes
sed -n '/^release_tag()/,/^}/p;/^pin_tag()/,/^}/p' scripts/cell-provision.sh > "$T/pin.sh"
# shellcheck disable=SC1091
source "$T/pin.sh"
cat > "$T/bin/helm" <<'FAKE'
#!/usr/bin/env bash
# fake helm: status → exit HELM_ABSENT; get values → the stored values with HELM_TAG
case "$1" in
  status) [ "${HELM_ABSENT:-0}" = 1 ] && exit 1; echo '{"name":"globex","info":{"status":"deployed"}}';;
  get) printf '{"tenant":{"slug":"globex"}%s}\n' "${HELM_TAG:+,\"image\":{\"tag\":\"$HELM_TAG\"}}";;
esac
FAKE
chmod +x "$T/bin/helm"
cp deploy/cells/acme.values.yaml "$T/pin.values.yaml"; export VALUES="$T/pin.values.yaml" SLUG=globex
TAG=0.1.0-rc.21 pin_tag > "$T/pin.out" || { echo "FAIL: --tag must pass" >&2; exit 1; }
grep -q "image.tag \"0.1.0\" → 0.1.0-rc.21" "$T/pin.out" && grep -q "managedRunners.image.tag \"0.1.0\" → 0.1.0-rc.21" "$T/pin.out" || { echo "FAIL: $(cat "$T/pin.out")" >&2; exit 1; }
[ "$(values_get image tag)" = "0.1.0-rc.21" ] && [ "$(values_get web image tag)" = "0.1.0-rc.21" ] || { echo "FAIL: tag not written: $(grep tag "$VALUES")" >&2; exit 1; }
TAG="" HELM_TAG=0.1.0-rc.21 pin_tag > /dev/null || { echo "FAIL: the release runs the file's tag: must pass" >&2; exit 1; }
if TAG="" HELM_TAG=0.1.0-rc.20 pin_tag > /dev/null 2> "$T/pin.err"; then echo "FAIL: a release on another tag must be refused without --tag" >&2; exit 1; fi
grep -q "runs image tag '0.1.0-rc.20' but .* says '0.1.0-rc.21'" "$T/pin.err" && grep -q -- "--tag 0.1.0-rc.20" "$T/pin.err" || { echo "FAIL: $(cat "$T/pin.err")" >&2; exit 1; }
TAG="" HELM_TAG="" pin_tag > /dev/null || { echo "FAIL: a release without a stored tag must pass" >&2; exit 1; }
TAG="" HELM_ABSENT=1 HELM_TAG=0.1.0-rc.20 pin_tag > /dev/null || { echo "FAIL: a new release must pass" >&2; exit 1; }
export VALUES=deploy/cells/acme.values.yaml

# 6. dry_run_rendered: the upgrade case — the realm-sync hook Job exists from the previous run (immutable
#    spec.template), the rendered chart carries the same Job; the fake kubectl rejects an APPLY of any Job that exists
#    (what the API server does) and accepts CREATE of a new name. Without the hook split the check fails; with it, passes.
sed -n '/^dry_run_rendered()/,/^}/p' scripts/cell-provision.sh > "$T/dry_run.sh"
# shellcheck disable=SC1091
source "$T/dry_run.sh"
K=(kubectl -n tenant-globex)   # used by dry_run_rendered
# shellcheck disable=SC2034
: "${K[0]}"
cat > "$T/bin/kubectl" <<'FAKE'
#!/usr/bin/env bash
# fake API server: Jobs named in EXISTING_JOBS exist; apply of such a Job → "field is immutable"; create of an existing
# name → AlreadyExists; everything else passes. Reads -f FILE.
f=""; verb=""; while [ $# -gt 0 ]; do case "$1" in -f|-n) [ "$1" = -f ] && f="$2"; shift;; -*) ;; *) [ -n "$verb" ] || verb="$1";; esac; shift; done
python3 - "$f" "$verb" <<'PY2'
import re, sys, os
text, verb = open(sys.argv[1]).read(), sys.argv[2]
existing = set(os.environ.get("EXISTING_JOBS", "").split(","))
for doc in re.split(r"(?m)^---[ \t]*$", text):
    if not re.search(r"(?m)^kind: Job$", doc): continue
    name = re.search(r"(?m)^metadata:\n(?:  .*\n|\n)*?  name:[ \t]+(\S+)", doc).group(1)
    if name in existing:
        if verb == "apply": print(f'The Job "{name}" is invalid: spec.template: Invalid value: ...: field is immutable', file=sys.stderr); sys.exit(1)
        if verb == "create": print(f'jobs.batch "{name}" already exists', file=sys.stderr); sys.exit(1)
PY2
FAKE
chmod +x "$T/bin/kubectl"
# a rendered chart: a ConfigMap and the hook Job as the chart renders it
cat > "$T/all.yaml" <<'YAML'
---
# Source: secops-cell/templates/keycloak.yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: globex-keycloak-realm
data:
  realm.json: "{}"
---
# Source: secops-cell/templates/keycloak.yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: globex-realm-sync
  annotations:
    helm.sh/hook: post-install,post-upgrade
    helm.sh/hook-weight: "5"
    helm.sh/hook-delete-policy: before-hook-creation
spec:
  template:
    spec:
      restartPolicy: Never
      containers: [{ name: sync, image: node:22-alpine }]
YAML
export EXISTING_JOBS=globex-realm-sync
# the fake rejects what the API server rejects: an apply of the raw render
if kubectl -n tenant-globex apply --dry-run=server -f "$T/all.yaml" 2> "$T/raw.err"; then echo "FAIL: the fake API server must reject the existing Job" >&2; exit 1; fi
grep -q "field is immutable" "$T/raw.err" || { echo "FAIL: $(cat "$T/raw.err")" >&2; exit 1; }
# the check apply runs: passes over the existing Job
dry_run_rendered "$T/all.yaml" > "$T/dry.out" 2>&1 || { echo "FAIL: dry_run_rendered must pass over an existing hook Job: $(cat "$T/dry.out")" >&2; exit 1; }
grep -q "1 resources to apply, 1 hook(s) checked as new objects" "$T/dry.out" || { echo "FAIL: $(cat "$T/dry.out")" >&2; exit 1; }
# and on a fresh namespace
EXISTING_JOBS='' dry_run_rendered "$T/all.yaml" > "$T/dry.out" 2>&1 || { echo "FAIL: dry_run_rendered must pass on a fresh namespace: $(cat "$T/dry.out")" >&2; exit 1; }
# a real error in a non-hook resource still fails (the fake rejects a Job named in EXISTING_JOBS whatever the annotations)
sed 's/helm.sh\/hook:/not-a-hook:/' "$T/all.yaml" > "$T/plain.yaml"
if dry_run_rendered "$T/plain.yaml" > "$T/dry.out" 2>&1; then echo "FAIL: an invalid non-hook resource must fail the check" >&2; exit 1; fi
# the splitter: no hook left in the rest, the hook renamed and still annotated
python3 scripts/lib/split-hooks.py --rest "$T/rest.yaml" --hooks "$T/hooks.yaml" --suffix dryrun-7 < "$T/all.yaml" 2> /dev/null
grep -q "helm.sh/hook" "$T/rest.yaml" && { echo "FAIL: a hook left among the resources to apply" >&2; exit 1; }
grep -q "^kind: ConfigMap" "$T/rest.yaml" || { echo "FAIL: the ConfigMap is missing from the rest" >&2; exit 1; }
grep -q "^  name: globex-realm-sync-dryrun-7$" "$T/hooks.yaml" && grep -q "helm.sh/hook: post-install" "$T/hooks.yaml" || { echo "FAIL: hook not renamed: $(cat "$T/hooks.yaml")" >&2; exit 1; }
unset EXISTING_JOBS

echo "cell-provision ok (new picks the issuer per context; values_get reads the generated file with PyYAML and without; checks skip terminating and replaced pods; readiness probe retries with backoff and reports the last status; failed / pending releases are recovered or explained; the server-side dry run passes over an existing hook Job; --tag is pinned in the values file and a release on another tag is refused without it; a probe pod without a verdict is retried inside the budget, with diagnostics when it persists)"
