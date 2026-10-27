#!/usr/bin/env bash
# Provision (or upgrade) one tenant cell from its values file in deploy/cells/<slug>.values.yaml.
#   scripts/cell-provision.sh new  --slug globex --name "Globex Corporation" --domain platform.example.com --admin ciso@globex.com [--issuer letsencrypt]
#       writes deploy/cells/globex.values.yaml from deploy/cells/_template.values.yaml (then edit it, commit it);
#       the cert-manager issuer defaults to `selfsigned` when the current context is the kind cluster, else `letsencrypt`
#   scripts/cell-provision.sh apply --slug globex [--tag 0.2.0] [--dry-run] [--no-wait] [--no-backup]
#       preflight → (existing cell: pre-upgrade backup) → helm upgrade --install → wait for the workloads (progress
#       every 15 s) → (new cell: first backup, which also binds the backups PVC) → checks
#       --tag X is written into the values file first (the four image tags; scripts/lib/values-image-tag.py), so later
#       applies without --tag keep it; an apply without --tag refuses to move an existing release to a different tag
#       than the one it runs (the values file disagrees with the release: pass --tag to say which one is right)
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
SLUG=""; NAME=""; DOMAIN=""; ADMINS=""; TAG=""; ISSUER=""; DRY=0; WAIT=1; FIRST_BACKUP=1; TIMEOUT="${TIMEOUT:-900}"; EXTRA=()
usage() { sed -n '2,11p' "$0"; exit "${1:-0}"; }
while [ $# -gt 0 ]; do
  case "$1" in
    --slug) SLUG="$2"; shift 2;;
    --name) NAME="$2"; shift 2;;
    --domain) DOMAIN="$2"; shift 2;;
    --admin) ADMINS="$2"; shift 2;;
    --tag) TAG="$2"; shift 2;;
    --issuer) ISSUER="$2"; shift 2;;
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
# values_get <key> [<key>…]: one scalar from the values file ($VALUES) by key path, parsed as YAML (PyYAML when
# installed, else a small indentation parser for the shapes this template uses) — never by grep: an inline comment
# such as `cluster-issuer: selfsigned   # letsencrypt in production` must yield `selfsigned`, and quotes must be dropped.
values_get() { python3 - "$VALUES" "$@" <<'PY'
import sys
file, path = sys.argv[1], sys.argv[2:]
text = open(file, encoding="utf-8").read()
try:
    import yaml
    data = yaml.safe_load(text)
except ImportError:
    def strip(line):  # comment outside quotes
        out, q = [], None
        for ch in line:
            if q: out.append(ch); q = None if ch == q else q
            elif ch in "\"'": q = ch; out.append(ch)
            elif ch == "#": break
            else: out.append(ch)
        return "".join(out).rstrip()
    def scalar(v):
        v = v.strip()
        if len(v) >= 2 and v[0] == v[-1] and v[0] in "\"'": return v[1:-1]
        if v in ("true", "True"): return True
        if v in ("false", "False"): return False
        if v.startswith("[") and v.endswith("]"): return [scalar(x) for x in v[1:-1].split(",") if x.strip()]
        if v.startswith("{") and v.endswith("}"): return {}
        return v
    data, stack = {}, [(-1, {})]
    stack[0] = (-1, data)
    for raw in text.splitlines():
        line = strip(raw)
        if not line.strip() or line.lstrip().startswith("-"): continue
        indent = len(line) - len(line.lstrip())
        key, _, val = line.strip().partition(":")
        while stack and indent <= stack[-1][0]: stack.pop()
        parent = stack[-1][1]
        if val.strip() == "": parent[key] = {}; stack.append((indent, parent[key]))
        else: parent[key] = scalar(val)
cur = data
for part in path:
    cur = (cur or {}).get(part) if isinstance(cur, dict) else None
if cur is None: print("")
elif isinstance(cur, bool): print("true" if cur else "false")
elif isinstance(cur, list): print(",".join(str(x) for x in cur))
else: print(cur)
PY
}

# ---- new: write the cell's values file from the template --------------------------------------
cmd_new() {
  [ -n "$NAME" ] && [ -n "$DOMAIN" ] && [ -n "$ADMINS" ] || { echo "new needs --name, --domain and --admin" >&2; exit 1; }
  [ -f "$VALUES" ] && { echo "$VALUES exists; edit it or delete it first" >&2; exit 1; }
  local admins; admins="$(printf '%s' "$ADMINS" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | sed 's/.*/"&"/' | paste -sd, -)"
  # TLS is not optional on a real hostname (browsers sign in only in a secure context); the issuer is the only choice:
  # the kind cluster has the local CA issuer `selfsigned` (scripts/kind-up.sh), anything else defaults to `letsencrypt`
  if [ -z "$ISSUER" ]; then case "$(kubectl config current-context 2>/dev/null || true)" in kind-secops) ISSUER=selfsigned;; *) ISSUER=letsencrypt;; esac; fi
  sed -e "s|__SLUG__|$SLUG|g" -e "s|__NAME__|$NAME|g" -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__ADMINS__|[$admins]|g" -e "s|__ISSUER__|$ISSUER|g" "$CELLS/_template.values.yaml" > "$VALUES"
  echo "wrote $VALUES (TLS on, cert-manager issuer: $ISSUER)"
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
  local cls; cls="$(values_get ingress className)"; cls="${cls:-nginx}"
  local failed=0
  if kubectl get ingressclass "$cls" > /dev/null 2>&1; then echo "   ingress:   class $cls present"; else echo "   ingress:   class $cls NOT found (ingress.className)" >&2; failed=1; fi
  local tls; tls="$(values_get ingress tls)"
  if [ "$tls" = true ]; then
    local issuer; issuer="$(values_get ingress annotations cert-manager.io/cluster-issuer)"
    if [ -n "$issuer" ]; then
      if kubectl get clusterissuer "$issuer" > /dev/null 2>&1; then echo "   tls:       ClusterIssuer $issuer present"; else echo "   tls:       ClusterIssuer $issuer NOT found (cert-manager)" >&2; failed=1; fi
    else echo "   tls:       on, no cert-manager issuer annotation — provide the Secret $RELEASE-app-tls (and -auth-tls, -registry-tls) yourself"; fi
  fi
  local domain; domain="$(values_get tenant domain)"
  if [ "$tls" != true ]; then
    case "$domain" in localhost|*.localhost|127.0.0.1) echo "   tls:       off (fine on localhost)";;
      *) echo "   tls:       OFF on $SLUG.$domain — WARNING: browsers treat only https:// and localhost as secure contexts; the Keycloak login page will fail (\"Crypto.subtle is available only in secure contexts\"). Set ingress.tls: true with a cert-manager issuer (kind: selfsigned). API and CLI still work." >&2;;
    esac
  fi
  local h; for h in "$SLUG.$domain" "auth-$SLUG.$domain" "registry-$SLUG.$domain"; do
    if getent hosts "$h" > /dev/null 2>&1; then echo "   dns:       $h resolves"; else echo "   dns:       $h does not resolve yet (fine on kind / before the wildcard record)"; fi
  done
  [ "$failed" = 0 ] || { echo "preflight failed: fix the items marked NOT found (or change the values file)" >&2; exit 1; }
}

# ---- apply --------------------------------------------------------------------------------------
# The image tag the release runs now (helm's stored values: what the last apply passed through the values file or
# --set; empty when the release does not exist or never set a tag).
release_tag() {
  helm get values "$RELEASE" -n "$NAMESPACE" -o json 2>/dev/null | python3 -c 'import json,sys
try: d = json.load(sys.stdin) or {}
except Exception: d = {}
print(((d.get("image") or {}).get("tag") or ""))' 2>/dev/null || true
}

# pin_tag: --tag goes into the values file (the source of truth for every later apply); without --tag, an existing
# release keeps running the tag it has only if the file names the same one — the chart default would otherwise roll
# every image to the chart's appVersion silently (a kind cell lost its realm-sync image that way).
pin_tag() {
  if [ -n "$TAG" ]; then
    python3 scripts/lib/values-image-tag.py "$VALUES" "$TAG" | sed 's/^/   /'
    echo "   (commit $VALUES: the tag is part of the cell's definition now)"
    return 0
  fi
  helm status "$RELEASE" -n "$NAMESPACE" > /dev/null 2>&1 || return 0
  local running file; running="$(release_tag)"; file="$(values_get image tag)"
  [ -n "$running" ] || return 0
  [ "$running" = "$file" ] && return 0
  echo "release $RELEASE runs image tag '$running' but $VALUES says '${file:-<unset: the chart default>}': an apply without --tag would move every image to '${file:-the chart default}'." >&2
  echo "   keep it:    scripts/cell-provision.sh apply --slug $SLUG --tag $running      (writes the tag into the values file)" >&2
  echo "   upgrade it: scripts/cell-provision.sh apply --slug $SLUG --tag <new tag>" >&2
  return 1
}

cmd_apply() {
  preflight
  pin_tag || exit 1
  FILLED="$(mktemp)"; trap 'rm -f "$FILLED"' EXIT
  # fill ${VAR} placeholders from the environment: only the variables the file names, values taken literally
  local content v; content="$(cat "$VALUES")"
  for v in $(placeholders | tr -d '${}'); do content="${content//\$\{$v\}/${!v}}"; done
  printf '%s\n' "$content" > "$FILLED"
  local filled="$FILLED"
  local args=(upgrade --install "$RELEASE" "$CHART" --namespace "$NAMESPACE" --create-namespace -f "$filled" --set "tenant.slug=$SLUG" ${EXTRA[@]+"${EXTRA[@]}"})
  [ -n "$TAG" ] && args+=(--set "image.tag=$TAG" --set "worker.image.tag=$TAG" --set "web.image.tag=$TAG" --set "managedRunners.image.tag=$TAG")
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
  if [ "$existed" = 1 ]; then
    release_recoverable || exit 1
    # what `helm --dry-run` cannot see, the API server can: validate the rendered chart server-side before touching
    # the release (a ConfigMap key in both data and binaryData, a schema error) — the upgrade starts only when it passes.
    # Hooks are checked apart (scripts/lib/split-hooks.py): the realm-sync Job exists from the previous run until helm
    # deletes and recreates it (hook-delete-policy before-hook-creation) and a Job's spec.template is immutable, so a
    # dry-run APPLY of it fails with "field is immutable" on every upgrade — it is validated as a NEW object instead
    # (kubectl create --dry-run=server on a copy with a unique name). Server-side apply for the rest: no
    # last-applied-configuration annotation needed; --force-conflicts because helm owns the fields and nothing persists
    say "server-side validation of the rendered chart (kubectl apply --dry-run=server; hooks as new objects)"
    local rendered; rendered="$(mktemp -d)"
    helm template "$RELEASE" "$CHART" --namespace "$NAMESPACE" -f "$filled" --set "tenant.slug=$SLUG" ${EXTRA[@]+"${EXTRA[@]}"} ${TAG:+--set "image.tag=$TAG" --set "worker.image.tag=$TAG" --set "web.image.tag=$TAG" --set "managedRunners.image.tag=$TAG"} > "$rendered/all.yaml"
    dry_run_rendered "$rendered/all.yaml" || { rm -rf "$rendered"; echo "the API server rejects the rendered chart (see above) — nothing was changed; fix the chart or the values and apply again" >&2; exit 1; }
    rm -rf "$rendered"
  fi
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
  # the realm-sync hook ran inside helm (hooks are waited for): one line of what it did, for the apply log
  local sync_log; sync_log="$("${K[@]}" logs "job/$RELEASE-realm-sync" --tail 3 2>/dev/null | grep -E '^realm ' | tail -1 || true)"
  echo "   realm-sync: ${sync_log:-no log (kubectl -n $NAMESPACE logs job/$RELEASE-realm-sync)}"
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
# readiness_script — the sh loop the probe pod runs: `sh -c "$(readiness_script)" probe <url> <timeout-seconds>`.
#   GET until 200, retrying with backoff (2, 4, 8, 10, 10 … s) up to the timeout; prints one line per failed attempt
#   with the HTTP status (000 = no connection) and the start of the error / body, then "READY <attempts> <seconds>"
#   or "FAILED <attempts> <seconds> <status>" followed by the last body.
readiness_script() {
  cat <<'SH'
url="$1"; limit="${2:-60}"; start=$(date +%s); delay=2; n=0
while :; do
  n=$((n+1))
  code=$(curl -sS --max-time 10 -o /tmp/body -w '%{http_code}' "$url" 2>/tmp/err) || code=000
  now=$(date +%s); elapsed=$((now-start))
  if [ "$code" = 200 ]; then echo "READY $n $elapsed"; exit 0; fi
  echo "attempt $n (${elapsed}s): HTTP $code $(cat /tmp/err /tmp/body 2>/dev/null | tr '\n' ' ' | head -c 160)"
  if [ "$elapsed" -ge "$limit" ]; then echo "FAILED $n $elapsed $code"; head -c 300 /tmp/body 2>/dev/null; echo; exit 1; fi
  sleep "$delay"; [ "$delay" -lt 10 ] && delay=$((delay*2)); [ "$delay" -gt 10 ] && delay=10
done
SH
}

# readiness_report <url> <probe output> — prints the api line; returns 1 when the probe never got a 200
readiness_report() {
  local url="$1" out="$2" verdict
  verdict="$(printf '%s\n' "$out" | grep -E '^(READY|FAILED) ' | tail -1)"
  case "$verdict" in
    READY*)
      set -- $verdict
      if [ "$2" -gt 1 ]; then
        echo "   api:      GET $url → 200 after ${3}s and $2 attempts (the first $(($2 - 1)) got no answer: the Service endpoints were still switching)"
        printf '%s\n' "$out" | grep '^attempt ' | sed 's/^/             /'
      else echo "   api:      GET $url → 200 (ready in ${3}s)"; fi
      return 0;;
    FAILED*)
      set -- $verdict
      echo "   api:      GET $url → no 200 in ${3}s ($2 attempts); last: HTTP $4 $(printf '%s\n' "$out" | sed -n '/^FAILED /,$p' | tail -n +2 | tr '\n' ' ' | head -c 300)" >&2
      printf '%s\n' "$out" | grep '^attempt ' | tail -3 | sed 's/^/             /' >&2
      return 1;;
    *)
      # no READY / FAILED line: the probe POD itself did not run to completion (kubectl run lost its attach right after
      # a rollout, the pod was evicted, the image was not there yet) — not a verdict on the cell: the caller retries
      return 2;;
  esac
}

# probe_run <url> <seconds> [pod name] — one probe pod; prints its output. Overridden by the unit test.
probe_run() {
  local url="$1" seconds="$2" name="${3:-$RELEASE-check-$$-$RANDOM}" rm="--rm"
  [ -n "${3:-}" ] && rm=""   # a named pod is kept for the diagnostics below
  # shellcheck disable=SC2086
  "${K[@]}" run "$name" $rm -i --restart=Never --quiet --image=curlimages/curl:8.11.1 -- sh -c "$(readiness_script)" probe "$url" "$seconds" 2>&1 || true
}

# probe_cell <url> <budget seconds> — the readiness probe with the budget shared between the curl loop and the probe
# pod itself: a pod that gives no verdict (empty output, no READY / FAILED) is one more retry inside the budget, never
# "unhealthy" by itself; when that persists, the last pod is kept and its phase, last event and logs are printed.
probe_cell() {
  local url="$1" budget="${2:-60}" start now left out rc attempt=0
  start=$(date +%s)
  while :; do
    attempt=$((attempt + 1))
    now=$(date +%s); left=$((budget - (now - start)))
    [ "$left" -ge 5 ] || left=5
    out="$(probe_run "$url" "$left")"
    readiness_report "$url" "$out"; rc=$?
    [ "$rc" = 2 ] || { [ "$attempt" -gt 1 ] && echo "             (the first $((attempt - 1)) probe pod(s) gave no verdict)"; return "$rc"; }
    now=$(date +%s)
    if [ $((now - start + 8)) -ge "$budget" ]; then
      # a kept pod for the evidence: what the cluster did with it
      local name="$RELEASE-check-$$-last"
      out="$(probe_run "$url" 5 "$name")"
      readiness_report "$url" "$out"; rc=$?
      if [ "$rc" = 2 ]; then
        echo "   api:      GET $url → the probe pod gave no verdict $attempt times in ${budget}s (its output: $(printf '%s' "$out" | tr '\n' ' ' | head -c 200))" >&2
        echo "             pod $name: phase $("${K[@]}" get pod "$name" -o jsonpath='{.status.phase}' 2>/dev/null || echo unknown); last event: $("${K[@]}" get events --field-selector "involvedObject.name=$name" -o jsonpath='{.items[-1:].reason}{\": \"}{.items[-1:].message}' 2>/dev/null | head -c 200)" >&2
        "${K[@]}" logs "$name" 2>/dev/null | tail -5 | sed 's/^/             log: /' >&2
      fi
      "${K[@]}" delete pod "$name" --wait=false > /dev/null 2>&1 || true
      [ "$rc" = 2 ] && return 1
      return "$rc"
    fi
    sleep 3
  done
}

# dry_run_rendered <rendered.yaml> — the server-side dry run of a rendered chart, hooks apart (see apply):
# non-hook resources through `apply --dry-run=server` as they will be applied, hooks through `create --dry-run=server`
# under a unique name so an existing hook Job (immutable spec.template) cannot make the check fail.
dry_run_rendered() {   # the namespace comes with K
  local all="$1" dir; dir="$(mktemp -d)"
  python3 scripts/lib/split-hooks.py --rest "$dir/rest.yaml" --hooks "$dir/hooks.yaml" --suffix "dryrun-$(date +%s)" < "$all" 2> "$dir/split.log" || { cat "$dir/split.log" >&2; rm -rf "$dir"; return 1; }
  sed 's/^/   /' "$dir/split.log"
  "${K[@]}" apply --server-side --dry-run=server --field-manager=cell-provision-check --force-conflicts -f "$dir/rest.yaml" > /dev/null || { rm -rf "$dir"; return 1; }
  if [ -s "$dir/hooks.yaml" ]; then
    "${K[@]}" create --dry-run=server -f "$dir/hooks.yaml" > /dev/null || { rm -rf "$dir"; return 1; }
  fi
  rm -rf "$dir"; echo "   ok"
}

# release_recoverable — a release left failed / pending by an earlier apply: helm upgrades over `failed` when a good
# revision exists; `pending-*` (an interrupted helm) is rolled back to the last good revision first; a release whose
# every revision failed cannot be upgraded ("has no deployed releases") — say what to do instead of failing inside helm.
release_recoverable() {
  local st; st="$(helm status "$RELEASE" -n "$NAMESPACE" -o json 2>/dev/null | sed -n 's/.*"status":"\([a-z-]*\)".*/\1/p' | head -1)"
  case "$st" in
    deployed) return 0;;
    failed)
      if helm history "$RELEASE" -n "$NAMESPACE" 2>/dev/null | grep -qE '(deployed|superseded)'; then
        echo "   release $RELEASE is 'failed' from an earlier apply (a good revision exists): upgrading over it"; return 0
      fi
      echo "release $RELEASE is 'failed' and no revision ever deployed: helm cannot upgrade it. Look at 'helm history $RELEASE -n $NAMESPACE' and 'kubectl -n $NAMESPACE get pods'; a first install that never came up is removed with 'helm uninstall $RELEASE -n $NAMESPACE' (the namespace and its volumes stay) and applied again" >&2
      return 1;;
    pending-install|pending-upgrade|pending-rollback)
      local last; last="$(helm history "$RELEASE" -n "$NAMESPACE" 2>/dev/null | awk '$7 == "deployed" || $7 == "superseded" { r = $1 } END { print r }')"
      echo "   release $RELEASE is '$st' (an earlier helm was interrupted)${last:+; rolling back to revision $last first}"
      [ -n "$last" ] || { echo "no good revision to roll back to: helm history $RELEASE -n $NAMESPACE" >&2; return 1; }
      helm rollback "$RELEASE" "$last" -n "$NAMESPACE" --wait --timeout 5m || { echo "rollback failed" >&2; return 1; }
      return 0;;
    *) echo "   release $RELEASE is '${st:-unknown}'"; return 0;;
  esac
}

# restart_report <old-replicasets,comma-separated> < pods.tsv
#   pods.tsv: name, restartCounts, last reason, last finishedAt, startTime, deletionTimestamp, owner kind, owner name.
#   Prints one line per pod whose containers restarted, skipping terminating pods and pods of scaled-down ReplicaSets.
restart_report() {
  awk -F'\t' -v old=",$1" '
    $6 != "" { skipped++; next }
    $7 == "ReplicaSet" && index(old, "," $8 ",") { skipped++; next }
    { n = 0; split($2, c, " "); for (i in c) if (c[i] + 0 > n) n = c[i] + 0
      if (n > 0) printf "   restarts: %s %d (last: %s at %s; pod started %s)\n", $1, n, ($3 == "" ? "?" : $3), ($4 == "" ? "?" : $4), $5 }
    END { if (skipped) printf "   (%d terminating or replaced pod%s not counted)\n", skipped, (skipped == 1 ? "" : "s") }'
}

cmd_check() {
  require_cluster
  say "checks ($NAMESPACE)"
  local bad=0
  "${K[@]}" get pods -o wide | sed 's/^/   /'
  "${K[@]}" rollout status "deployment/$RELEASE-api" --timeout=300s > /dev/null || bad=1
  "${K[@]}" rollout status "deployment/$RELEASE-worker" --timeout=120s > /dev/null || bad=1
  "${K[@]}" rollout status "deployment/$RELEASE-keycloak" --timeout=300s > /dev/null 2>&1 || true
  # container restarts with when and why: restartCount is the container's crash/probe counter inside the SAME pod (a
  # rollout makes a new pod at 0), so a count carried over from the first start is not caused by this upgrade
  # pods on their way out are skipped: terminating (deletionTimestamp set) or owned by a ReplicaSet the rollout has
  # scaled to 0 — their counters belong to the previous release, not to this one
  local old_rs; old_rs="$("${K[@]}" get replicasets -o jsonpath='{range .items[?(@.spec.replicas==0)]}{.metadata.name}{","}{end}' 2>/dev/null || true)"
  local restarts; restarts="$("${K[@]}" get pods -o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.containerStatuses[*].restartCount}{"\t"}{.status.containerStatuses[*].lastState.terminated.reason}{"\t"}{.status.containerStatuses[*].lastState.terminated.finishedAt}{"\t"}{.status.startTime}{"\t"}{.metadata.deletionTimestamp}{"\t"}{.metadata.ownerReferences[0].kind}{"\t"}{.metadata.ownerReferences[0].name}{"\n"}{end}' 2>/dev/null | restart_report "$old_rs")"
  [ -n "$restarts" ] && echo "$restarts"
  # the API answers through its Service (no DNS needed yet); the port comes from the Service, never hard-coded
  local port; port="$("${K[@]}" get service "$RELEASE-api" -o jsonpath='{.spec.ports[?(@.name=="http")].port}' 2>/dev/null)"; port="${port:-80}"
  # Probed from inside the cluster by one short-lived curl pod that retries with backoff for up to READY_TIMEOUT
  # seconds: right after a rollout the Service endpoints have just switched and the first request can hit nothing
  # (or the pod being removed) — that is a window, not an unhealthy cell. The last failure keeps its status and body.
  local url="http://$RELEASE-api:$port/api/v1/health/ready"
  if ! probe_cell "$url" "${READY_TIMEOUT:-60}"; then bad=1; fi
  if "${K[@]}" get cronjob "$RELEASE-backup" > /dev/null 2>&1; then echo "   backups:  CronJob $RELEASE-backup ($("${K[@]}" get cronjob "$RELEASE-backup" -o jsonpath='{.spec.schedule}') UTC)"; else echo "   backups:  OFF — set backup.enabled=true before this cell holds real data" >&2; fi
  helm get notes "$RELEASE" -n "$NAMESPACE" 2>/dev/null | sed 's/^/   /'
  [ "$bad" = 0 ] || { echo "cell $SLUG is not healthy" >&2; exit 1; }
  say "cell $SLUG is up"
  if "${K[@]}" get secret "$RELEASE-keycloak" -o jsonpath='{.data.SEED_ADMIN_PASSWORD}' 2>/dev/null | grep -q .; then
    echo "   sign in:  $(values_get tenant adminEmails | tr ',' ' ') — temporary password (changed at the first login):"
    echo "             kubectl -n $NAMESPACE get secret $RELEASE-keycloak -o jsonpath='{.data.SEED_ADMIN_PASSWORD}' | base64 -d; echo"
  fi
  echo "   handover: docs/cell-provisioning.md §Handover (IdP in Keycloak, first admin login, make backup TENANT=$SLUG)"
}

case "$CMD" in
  new) cmd_new;;
  apply) cmd_apply;;
  check) cmd_check;;
  ""|-h|--help) usage;;
  *) echo "unknown command: $CMD" >&2; usage 1;;
esac
