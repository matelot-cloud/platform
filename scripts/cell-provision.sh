#!/usr/bin/env bash
# Provision (or upgrade) one tenant cell from its values file in deploy/cells/<slug>.values.yaml.
#   scripts/cell-provision.sh new  --slug globex --name "Globex Corporation" --domain platform.example.com --admin ciso@globex.com
#       writes deploy/cells/globex.values.yaml from deploy/cells/_template.values.yaml (then edit it, commit it)
#   scripts/cell-provision.sh apply --slug globex [--tag 0.2.0] [--dry-run] [--no-wait] [--no-backup]
#       preflight → (existing cell: pre-upgrade backup) → helm upgrade --install → wait for the workloads (progress
#       every 15 s) → (new cell: first backup, which also binds the backups PVC) → checks
#       (helm's own --wait is not used: it also waits for the backups PVC, which on WaitForFirstConsumer storage —
#       kind, EKS gp3, GKE, AKS — binds only when the first backup mounts it, so a plain `helm install --wait` hangs)
#   scripts/cell-provision.sh check --slug globex
#       the post-install checks only
# Secrets never go into the values file: ${VAR} placeholders in it are filled from the environment at apply time
# (e.g. DB_PASSWORD, KC_ADMIN_PASSWORD) and the filled copy lives only in a temp file. See docs/cell-provisioning.md.
set -euo pipefail
shopt -u patsub_replacement 2>/dev/null || true  # bash 5.2: "&" in a substituted secret must stay literal
cd "$(dirname "$0")/.."
CHART=deploy/helm/secops-cell
CELLS=deploy/cells
# shellcheck source=scripts/lib/wait.sh
source scripts/lib/wait.sh
CMD="${1:-}"; shift || true
SLUG=""; NAME=""; DOMAIN=""; ADMINS=""; TAG=""; DRY=0; WAIT=1; FIRST_BACKUP=1; TIMEOUT="${TIMEOUT:-900}"; EXTRA=()
usage() { sed -n '2,11p' "$0"; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --admin) ADMINS="$2"; shift 2;;
    --tag) TAG="$2"; shift 2;;
    --dry-run) DRY=1; shift;;
    --no-wait) WAIT=0; shift;;
    --no-backup) FIRST_BACKUP=0; shift;;
    --set) EXTRA+=(--set "$2"); shift 2;;
    -h|--help) usage;;
    *) echo "unknown argument: $1" >&2; usage 1;;
  esac
done
[ -n "$SLUG" ] || { echo "--slug is required" >&2; usage 1; }
[[ "$SLUG" =~ ^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$ ]] || { echo "slug must be a DNS label: lowercase letters, digits, dashes (max 40)" >&2; exit 1; }
RELEASE="$SLUG"; NAMESPACE="tenant-$SLUG"; VALUES="$CELLS/$SLUG.values.yaml"
K=(kubectl -n "$NAMESPACE")
say() { printf '\n== %s\n' "$*"; }
# A kube context must be set and the cluster must answer, otherwise nothing below means anything.
CONTEXT=""
require_cluster() {
  CONTEXT="$(kubectl config current-context 2>/dev/null || true)"
  [ -n "$CONTEXT" ] || { echo "no kubectl context is set (kubectl config use-context …; on kind: make kind-up)" >&2; exit 1; }
  kubectl get --raw /readyz --request-timeout=10s > /dev/null 2>&1 || { echo "cluster of context '$CONTEXT' is unreachable (is it running? kubectl get --raw /readyz)" >&2; exit 1; }
}
# ${VAR} placeholders of the values file, comments excluded
placeholders() { sed 's/ *#.*$//' "$VALUES" | grep -o '\${[A-Z0-9_]*}' | sort -u || true; }

# ---- new: write the cell's values file from the template --------------------------------------
cmd_new() {
  [ -n "$NAME" ] && [ -n "$DOMAIN" ] && [ -n "$ADMINS" ] || { echo "new needs --name, --domain and --admin" >&2; exit 1; }
  [ -f "$VALUES" ] && { echo "$VALUES exists; edit it or delete it first" >&2; exit 1; }
  local admins; admins="$(printf '%s' "$ADMINS" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | sed 's/.*/"&"/' | paste -sd, -)"
  sed -e "s|__SLUG__|$SLUG|g" -e "s|__NAME__|$NAME|g" -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__ADMINS__|[$admins]|g" "$CELLS/_template.values.yaml" > "$VALUES"
  echo "wrote $VALUES"
  echo "next: review it (images, TLS issuer, database, backups), commit it, then: scripts/cell-provision.sh apply --slug $SLUG"
}

# ---- preflight ----------------------------------------------------------------------------------
preflight() {
  say "preflight"
  command -v helm > /dev/null || { echo "helm is required" >&2; exit 1; }
  command -v kubectl > /dev/null || { echo "kubectl is required" >&2; exit 1; }
  [ -f "$VALUES" ] || { echo "no $VALUES — run: scripts/cell-provision.sh new --slug $SLUG …" >&2; exit 1; }
  require_cluster
  echo "   context:   $CONTEXT"
  echo "   values:    $VALUES"
  # every ${VAR} placeholder in the values file must be set in the environment
  local missing=0 v
  for v in $(placeholders | tr -d '${}'); do
    if [ -z "${!v:-}" ]; then echo "   missing environment variable: $v (referenced in $VALUES)" >&2; missing=1; else echo "   secret:    $v (from environment)"; fi
  done
  [ "$missing" = 0 ] || exit 1
  local cls; cls="$(sed -n 's/^ *className: *\(.*\)$/\1/p' "$VALUES" | head -1 | tr -d '"')"; cls="${cls:-nginx}"
  local failed=0
  if kubectl get ingressclass "$cls" > /dev/null 2>&1; then echo "   ingress:   class $cls present"; else echo "   ingress:   class $cls NOT found (ingress.className)" >&2; failed=1; fi
  if grep -q '^ *tls: *true' "$VALUES"; then
    local issuer; issuer="$(sed -n 's/.*cert-manager.io\/cluster-issuer: *//p' "$VALUES" | head -1 | tr -d '"')"
    if [ -n "$issuer" ]; then
      if kubectl get clusterissuer "$issuer" > /dev/null 2>&1; then echo "   tls:       ClusterIssuer $issuer present"; else echo "   tls:       ClusterIssuer $issuer NOT found (cert-manager)" >&2; failed=1; fi
    else echo "   tls:       on, no cert-manager issuer annotation — provide the Secret $RELEASE-app-tls (and -auth-tls, -registry-tls) yourself"; fi
  fi
  local domain; domain="$(sed -n 's/^ *domain: *\(.*\)$/\1/p' "$VALUES" | head -1 | tr -d '"' | sed 's/ *#.*//')"
  local h; for h in "$SLUG.$domain" "auth-$SLUG.$domain" "registry-$SLUG.$domain"; do
    if getent hosts "$h" > /dev/null 2>&1; then echo "   dns:       $h resolves"; else echo "   dns:       $h does not resolve yet (fine on kind / before the wildcard record)"; fi
  done
  [ "$failed" = 0 ] || { echo "preflight failed: fix the items marked NOT found (or change the values file)" >&2; exit 1; }
}

# ---- apply --------------------------------------------------------------------------------------
cmd_apply() {
  preflight
  FILLED="$(mktemp)"; trap 'rm -f "$FILLED"' EXIT
  # fill ${VAR} placeholders from the environment: only the variables the file names, values taken literally
  local content v; content="$(cat "$VALUES")"
  for v in $(placeholders | tr -d '${}'); do content="${content//\$\{$v\}/${!v}}"; done
  printf '%s\n' "$content" > "$FILLED"
  local filled="$FILLED"
  local args=(upgrade --install "$RELEASE" "$CHART" --namespace "$NAMESPACE" --create-namespace -f "$filled" --set "tenant.slug=$SLUG" ${EXTRA[@]+"${EXTRA[@]}"})
  [ -n "$TAG" ] && args+=(--set "image.tag=$TAG" --set "web.image.tag=$TAG" --set "managedRunners.image.tag=$TAG")
  if [ "$DRY" = 1 ]; then
    say "helm ${args[*]} --dry-run"
    helm "${args[@]}" --dry-run > /dev/null || { echo "helm dry run failed (exit $?)" >&2; exit 1; }
    echo "   dry run ok (nothing applied)"
    local n; n="$(helm template "$RELEASE" "$CHART" --namespace "$NAMESPACE" -f "$filled" --set "tenant.slug=$SLUG" ${EXTRA[@]+"${EXTRA[@]}"} | grep -c '^kind:')" || { echo "helm template failed" >&2; exit 1; }
    echo "   resources: $n"
    return
  fi
  # an existing cell gets a backup BEFORE the upgrade: the safety net for the rollout (migrations included)
  local existed=0
  helm status "$RELEASE" -n "$NAMESPACE" > /dev/null 2>&1 && existed=1
  if [ "$existed" = 1 ] && [ "$FIRST_BACKUP" = 1 ] && "${K[@]}" get cronjob "$RELEASE-backup" > /dev/null 2>&1; then
    say "pre-upgrade backup"
    bash scripts/cell-backup.sh -r "$RELEASE" -n "$NAMESPACE" || { echo "the pre-upgrade backup failed; not upgrading (--no-backup to skip it)" >&2; exit 1; }
  fi
  say "helm ${args[*]}"
  local rc=0
  helm "${args[@]}" || rc=$?
  local status; status="$(helm status "$RELEASE" -n "$NAMESPACE" -o json 2>/dev/null | sed -n 's/.*"status":"\([a-z-]*\)".*/\1/p' | head -1)"
  if [ "$rc" != 0 ] || [ "$status" != deployed ]; then
    echo "helm exited $rc; release $RELEASE is '${status:-absent}' (expected deployed) — not running the checks" >&2
    echo "   helm history $RELEASE -n $NAMESPACE" >&2
    exit 1
  fi
  if [ "$WAIT" = 1 ]; then
    say "waiting for the workloads of $RELEASE (up to ${TIMEOUT}s)"
    wait_cell "$NAMESPACE" "$RELEASE" "$TIMEOUT" || { echo "cell $SLUG did not come up" >&2; exit 1; }
    if [ "$existed" = 0 ] && [ "$FIRST_BACKUP" = 1 ] && "${K[@]}" get cronjob "$RELEASE-backup" > /dev/null 2>&1; then
      # a new cell: the first backup right away proves the job works and binds the backups PVC (WaitForFirstConsumer storage)
      say "first backup"
      bash scripts/cell-backup.sh -r "$RELEASE" -n "$NAMESPACE" || { echo "the first backup failed; the cell is up but check the backup job" >&2; exit 1; }
    fi
  fi
  cmd_check
}

# ---- check + handover ---------------------------------------------------------------------------
cmd_check() {
  require_cluster
  say "checks ($NAMESPACE)"
  local bad=0
  "${K[@]}" get pods -o wide | sed 's/^/   /'
  "${K[@]}" rollout status "deployment/$RELEASE-api" --timeout=300s > /dev/null || bad=1
  "${K[@]}" rollout status "deployment/$RELEASE-worker" --timeout=120s > /dev/null || bad=1
  "${K[@]}" rollout status "deployment/$RELEASE-keycloak" --timeout=300s > /dev/null 2>&1 || true
  local restarts; restarts="$("${K[@]}" get pods -o jsonpath='{range .items[*]}{.metadata.name}{" "}{.status.containerStatuses[*].restartCount}{"\n"}{end}' | awk '$2 > 0 {print "   restarts: " $1 " " $2}')"
  [ -n "$restarts" ] && echo "$restarts"
  # the API answers through its Service (no DNS needed yet); the port comes from the Service, never hard-coded
  local port; port="$("${K[@]}" get service "$RELEASE-api" -o jsonpath='{.spec.ports[?(@.name=="http")].port}' 2>/dev/null)"; port="${port:-80}"
  local url="http://$RELEASE-api:$port/api/v1/health/ready" out ready
  out="$("${K[@]}" run "$RELEASE-check-$$" --rm -i --restart=Never --quiet --image=curlimages/curl:8.11.1 -- -sS --max-time 10 -o /dev/null -w '%{http_code}' "$url" 2>&1 || true)"
  ready="$(printf '%s' "$out" | grep -oE '[0-9]{3}$' || true)"
  if [ "$ready" = 200 ]; then echo "   api:      GET $url → 200"; else echo "   api:      GET $url → ${ready:-no answer}: $(printf '%s' "$out" | grep -v '^[0-9]*$' | tail -2 | tr '\n' ' ')" >&2; bad=1; fi
  if "${K[@]}" get cronjob "$RELEASE-backup" > /dev/null 2>&1; then echo "   backups:  CronJob $RELEASE-backup ($("${K[@]}" get cronjob "$RELEASE-backup" -o jsonpath='{.spec.schedule}') UTC)"; else echo "   backups:  OFF — set backup.enabled=true before this cell holds real data" >&2; fi
  helm get notes "$RELEASE" -n "$NAMESPACE" 2>/dev/null | sed 's/^/   /'
  [ "$bad" = 0 ] || { echo "cell $SLUG is not healthy" >&2; exit 1; }
  say "cell $SLUG is up"
  echo "   handover: docs/cell-provisioning.md §Handover (IdP in Keycloak, first admin login, make backup TENANT=$SLUG)"
}

case "$CMD" in
  new) cmd_new;;
  apply) cmd_apply;;
  check) cmd_check;;
  ""|-h|--help) usage;;
  *) echo "unknown command: $CMD" >&2; usage 1;;
esac
