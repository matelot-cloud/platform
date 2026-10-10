#!/usr/bin/env bash
# Runs every read-only CLI command against the platform and reports OK / FAIL.
#   export SECOPS_URL=… SECOPS_TOKEN=spt_…
#   bash secops-cli-check.sh --project <id> --service <id> --env <id> [--org <id>]
set -u
while [ $# -gt 0 ]; do case "$1" in --org) ORG=$2;; --project) PROJECT=$2;; --service) SERVICE=$2;; --env) ENV=$2;; esac; shift 2; done
: "${SECOPS_URL:?set SECOPS_URL}" "${SECOPS_TOKEN:?set SECOPS_TOKEN}"
command -v secops >/dev/null || { echo "secops not installed"; exit 2; }
ORG=${ORG:-$(secops orgs list --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")}
[ -n "${PROJECT:-}" ] || PROJECT=$(secops projects list --org "$ORG" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
[ -n "${SERVICE:-}" ] || SERVICE=$(secops services list --project "$PROJECT" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
[ -n "${ENV:-}" ] || ENV=$(secops envs list --service "$SERVICE" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(next((e['id'] for e in d if e['kind']=='production'), d[0]['id'] if d else ''))")
SBOM=$(secops sboms list --service "$SERVICE" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
JOB=$(secops jobs list --project "$PROJECT" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
PIPE=$(secops pipelines list --project "$PROJECT" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
FINDING=$(secops findings list --project "$PROJECT" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
echo "secops CLI check · $SECOPS_URL · org $ORG · project $PROJECT · service $SERVICE · env $ENV"; echo
pass=0; fail=0; skip=0
run() { # <label> <command…>
  local label=$1; shift
  for a in "$@"; do if [ -z "$a" ]; then printf '  %-8s %s (no id to test with)\n' SKIP "$label"; skip=$((skip+1)); return; fi; done
  out=$("$@" 2>&1); code=$?
  if [ $code -eq 0 ]; then printf '  %-8s %s\n' OK "$label"; pass=$((pass+1))
  elif [ $code -eq 2 ]; then printf '  %-8s %s → gate says FAIL (that is the gate working): %s\n' OK "$label" "${out##*$'\n'}"; pass=$((pass+1))
  else printf '  %-8s %s → %s\n' FAIL "$label" "${out##*$'\n'}"; fail=$((fail+1)); fi
}
run "whoami"                       secops whoami
run "meta show"                    secops meta show --json
run "me show"                      secops me show --json
run "orgs list"                    secops orgs list
run "org overview"                 secops org overview --org "$ORG" --json
run "workspaces list"              secops workspaces list --org "$ORG"
run "teams list"                   secops teams list --org "$ORG"
run "projects list"                secops projects list --org "$ORG"
run "project show"                 secops project show --project "$PROJECT" --json
run "project overview"             secops project overview --project "$PROJECT" --json
run "services list"                secops services list --project "$PROJECT"
run "services list-org"            secops services list-org --org "$ORG"
run "service show"                 secops service show --service "$SERVICE" --json
run "envs list"                    secops envs list --service "$SERVICE"
run "env show"                     secops env show --env "$ENV" --json
run "env registry"                 secops env registry --env "$ENV" --json
run "env lineage"                  secops env lineage --env "$ENV" --json
run "env gate"                     secops env gate --env "$ENV" --json
run "releases list"                secops releases list --service "$SERVICE"
run "images list"                  secops images list --service "$SERVICE"
run "inventory show"               secops inventory show --service "$SERVICE" --json
run "deployments list"             secops deployments list --service "$SERVICE" --json
run "deployments list-org"         secops deployments list-org --org "$ORG"
run "sboms list"                   secops sboms list --service "$SERVICE"
run "sbom show"                    secops sbom show --id "$SBOM" --json
run "sbom findings"                secops sbom findings --id "$SBOM"
run "components search"            secops components search --org "$ORG" --q a
run "findings list"                secops findings list --project "$PROJECT"
run "findings list-org"            secops findings list-org --org "$ORG"
run "findings summary"             secops findings summary --project "$PROJECT" --json
run "findings environments"        secops findings environments --project "$PROJECT"
run "findings trend"               secops findings trend --project "$PROJECT" --days 30 --json
run "finding show"                 secops finding show --id "$FINDING" --json
run "code-findings list"           secops code-findings list --project "$PROJECT"
run "code-findings summary"        secops code-findings summary --project "$PROJECT" --json
run "risk list"                    secops risk list --org "$ORG"
run "risk project"                 secops risk project --project "$PROJECT"
run "graph show"                   secops graph show --project "$PROJECT" --json
run "policies list"                secops policies list --org "$ORG"
run "policies in-force"            secops policies in-force --project "$PROJECT"
run "gate evaluations"             secops gate evaluations --service "$SERVICE"
run "pipelines list"               secops pipelines list --project "$PROJECT"
run "pipeline show"                secops pipeline show --id "$PIPE" --json
run "pipeline templates"           secops pipeline templates --json
run "jobs list"                    secops jobs list --project "$PROJECT"
run "jobs active"                  secops jobs active --org "$ORG"
run "job show"                     secops job show --id "$JOB" --json
run "job logs"                     secops job logs --id "$JOB"
run "runners list"                 secops runners list --org "$ORG" --json
run "runner agent"                 secops runner agent --json
run "integrations list"            secops integrations list --org "$ORG"
run "integrations providers"       secops integrations providers --json
run "repositories list"            secops repositories list --org "$ORG"
run "registries list"              secops registries list --service "$SERVICE"
run "registry info"                secops registry info --json
run "registry connections"         secops registry connections --service "$SERVICE"
run "registry path"                secops registry path --service "$SERVICE"
run "tokens list"                  secops tokens list
run "ci-tokens list"               secops ci-tokens list --org "$ORG"
run "audit list"                   secops audit list --org "$ORG" --limit 5
run "memberships list"             secops memberships list --scope-type PROJECT --scope-id "$PROJECT"
run "gate (version)"               secops gate --env "$ENV" --version v0.0.0-check
echo; echo "$pass ok · $fail failed · $skip skipped"
[ "$fail" -eq 0 ]
