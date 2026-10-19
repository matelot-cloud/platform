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
cp scripts/cell-provision.sh "$T/repo/scripts/"; cp scripts/lib/wait.sh "$T/repo/scripts/lib/"; cp deploy/cells/_template.values.yaml "$T/repo/deploy/cells/"
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

echo "cell-provision ok (new picks the issuer per context; values_get reads the generated file with PyYAML and without; checks skip terminating and replaced pods; readiness probe retries with backoff and reports the last status)"
