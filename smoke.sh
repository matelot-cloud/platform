#!/usr/bin/env bash
# End-to-end smoke test against a running cell: login, create a workspace/team/project, read the audit trail.
#   scripts/smoke.sh                                       # local: API on :3000, Keycloak on :8080
#   API=http://acme.platform.local/api/v1 KC=http://auth-acme.platform.local scripts/smoke.sh
set -euo pipefail
API="${API:-http://localhost:3000/api/v1}"
export KC="${KC:-http://localhost:8080}"
SUFFIX="$(date +%s)"
TOKEN="${TOKEN:-$("$(dirname "$0")/token.sh" "${KC_USER:-admin}" "${KC_PASS:-admin}")}"
H=(-sf -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json")
j() { python3 -c "import sys,json; d=json.load(sys.stdin); $1"; }

echo "== whoami";      curl "${H[@]}" "$API/me" | j 'print(" ", d["user"]["email"], [ (m["role"], m["scopeType"]) for m in d["memberships"] ])'
ORG=$(curl "${H[@]}" "$API/organizations" | j 'print(d[0]["id"])')
echo "== organization $ORG"
WS=$(curl "${H[@]}" -X POST "$API/organizations/$ORG/workspaces" -d "{\"slug\":\"payments-$SUFFIX\",\"name\":\"Payments\"}" | j 'print(d["id"])')
echo "== workspace    $WS"
TEAM=$(curl "${H[@]}" -X POST "$API/workspaces/$WS/teams" -d '{"slug":"backend","name":"Backend"}' | j 'print(d["id"])')
echo "== team         $TEAM"
PROJECT=$(curl "${H[@]}" -X POST "$API/teams/$TEAM/projects" -d '{"slug":"payment-api","name":"Payment API","criticality":"HIGH"}' | j 'print(d["id"])')
echo "== project      $PROJECT"
echo "== audit trail (latest 5)"
curl "${H[@]}" "$API/organizations/$ORG/audit-events?limit=5" | j 'exec("for e in d: print(\"  \", e[\"createdAt\"][:19], e[\"actorType\"], e[\"actorLabel\"], e[\"action\"])")'
echo "OK"
