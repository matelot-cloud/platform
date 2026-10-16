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

echo "cell-provision ok (new picks the issuer per context; values_get reads the generated file with PyYAML and without; checks skip terminating and replaced pods)"
