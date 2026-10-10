#!/usr/bin/env bash
# Runs every read-only CLI command against the platform and reports OK / FAIL.
#   export SECOPS_URL=… SECOPS_TOKEN=spt_…
#   bash secops-cli-check.sh --project <id> --service <id> --env <id> [--org <id>]
set -u
while [ $# -gt 0 ]; do case "$1" in --org) ORG=$2;; --project) PROJECT=$2;; --service) SERVICE=$2;; --env) ENV=$2;; esac; shift 2; done
: "${SECOPS_URL:?set SECOPS_URL}" "${SECOPS_TOKEN:?set SECOPS_TOKEN}"
command -v matelot >/dev/null || { echo "matelot not installed"; exit 2; }
ORG=${ORG:-$(matelot orgs list --json 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")}
[ -n "${PROJECT:-}" ] || PROJECT=$(matelot projects list --org "$ORG" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
[ -n "${SERVICE:-}" ] || SERVICE=$(matelot services list --project "$PROJECT" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
[ -n "${ENV:-}" ] || ENV=$(matelot envs list --service "$SERVICE" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(next((e['id'] for e in d if e['kind']=='production'), d[0]['id'] if d else ''))")
SBOM=$(matelot sboms list --service "$SERVICE" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
JOB=$(matelot jobs list --project "$PROJECT" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
PIPE=$(matelot pipelines list --project "$PROJECT" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
FINDING=$(matelot findings list --project "$PROJECT" --json | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[0]['id'] if d else '')")
echo "matelot CLI check · $SECOPS_URL · org $ORG · project $PROJECT · service $SERVICE · env $ENV"; echo
pass=0; fail=0; skip=0
run() { # <label> <command…>
  local label=$1; shift
  for a in "$@"; do if [ -z "$a" ]; then printf '  %-8s %s (no id to test with)\n' SKIP "$label"; skip=$((skip+1)); return; fi; done
  out=$("$@" 2>&1); code=$?
  if [ $code -eq 0 ]; then printf '  %-8s %s\n' OK "$label"; pass=$((pass+1))
  elif [ $code -eq 2 ]; then printf '  %-8s %s → gate says FAIL (that is the gate working): %s\n' OK "$label" "${out##*$'\n'}"; pass=$((pass+1))
  else printf '  %-8s %s → %s\n' FAIL "$label" "${out##*$'\n'}"; fail=$((fail+1)); fi
}
run "whoami"                       matelot whoami
run "meta show"                    matelot meta show --json
run "me show"                      matelot me show --json
run "orgs list"                    matelot orgs list
run "org overview"                 matelot org overview --org "$ORG" --json
run "workspaces list"              matelot workspaces list --org "$ORG"
run "teams list"                   matelot teams list --org "$ORG"
run "projects list"                matelot projects list --org "$ORG"
run "project show"                 matelot project show --project "$PROJECT" --json
run "project overview"             matelot project overview --project "$PROJECT" --json
run "services list"                matelot services list --project "$PROJECT"
run "services list-org"            matelot services list-org --org "$ORG"
run "service show"                 matelot service show --service "$SERVICE" --json
run "envs list"                    matelot envs list --service "$SERVICE"
run "env show"                     matelot env show --env "$ENV" --json
run "env registry"                 matelot env registry --env "$ENV" --json
run "env lineage"                  matelot env lineage --env "$ENV" --json
run "env gate"                     matelot env gate --env "$ENV" --json
run "releases list"                matelot releases list --service "$SERVICE"
run "images list"                  matelot images list --service "$SERVICE"
run "inventory show"               matelot inventory show --service "$SERVICE" --json
run "deployments list"             matelot deployments list --service "$SERVICE" --json
run "deployments list-org"         matelot deployments list-org --org "$ORG"
run "sboms list"                   matelot sboms list --service "$SERVICE"
run "sbom show"                    matelot sbom show --id "$SBOM" --json
run "sbom findings"                matelot sbom findings --id "$SBOM"
run "components search"            matelot components search --org "$ORG" --q a
run "findings list"                matelot findings list --project "$PROJECT"
run "findings list-org"            matelot findings list-org --org "$ORG"
run "findings summary"             matelot findings summary --project "$PROJECT" --json
run "findings environments"        matelot findings environments --project "$PROJECT"
run "findings trend"               matelot findings trend --project "$PROJECT" --days 30 --json
run "finding show"                 matelot finding show --id "$FINDING" --json
run "code-findings list"           matelot code-findings list --project "$PROJECT"
run "code-findings summary"        matelot code-findings summary --project "$PROJECT" --json
run "risk list"                    matelot risk list --org "$ORG"
run "risk project"                 matelot risk project --project "$PROJECT"
run "graph show"                   matelot graph show --project "$PROJECT" --json
run "policies list"                matelot policies list --org "$ORG"
run "policies in-force"            matelot policies in-force --project "$PROJECT"
run "gate evaluations"             matelot gate evaluations --service "$SERVICE"
run "pipelines list"               matelot pipelines list --project "$PROJECT"
run "pipeline show"                matelot pipeline show --id "$PIPE" --json
run "pipeline templates"           matelot pipeline templates --json
run "jobs list"                    matelot jobs list --project "$PROJECT"
run "jobs active"                  matelot jobs active --org "$ORG"
run "job show"                     matelot job show --id "$JOB" --json
run "job logs"                     matelot job logs --id "$JOB"
run "runners list"                 matelot runners list --org "$ORG" --json
run "runner agent"                 matelot runner agent --json
run "integrations list"            matelot integrations list --org "$ORG"
run "integrations providers"       matelot integrations providers --json
run "repositories list"            matelot repositories list --org "$ORG"
run "registries list"              matelot registries list --service "$SERVICE"
run "registry info"                matelot registry info --json
run "registry connections"         matelot registry connections --service "$SERVICE"
run "registry path"                matelot registry path --service "$SERVICE"
run "tokens list"                  matelot tokens list
run "ci-tokens list"               matelot ci-tokens list --org "$ORG"
run "audit list"                   matelot audit list --org "$ORG" --limit 5
run "memberships list"             matelot memberships list --scope-type PROJECT --scope-id "$PROJECT"
run "gate (version)"               matelot gate --env "$ENV" --version v0.0.0-check
echo; echo "$pass ok · $fail failed · $skip skipped"
[ "$fail" -eq 0 ]
