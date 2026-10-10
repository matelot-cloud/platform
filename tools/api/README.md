# Platform API with a personal access token

Create a token: **user menu → Access tokens** (`read`, `write`, or `sudo` for administrators).
Interactive reference: **`<SECOPS_URL>/api/docs`** (Swagger UI, "Authorize" → paste the token).

```bash
export SECOPS_URL=http://localhost:3000
export SECOPS_TOKEN=spt_…
H="Authorization: Bearer $SECOPS_TOKEN"
```

## 1. Check everything your token can reach
```bash
node secops-api-check.mjs                 # every GET endpoint of the running version (from /api/docs-json)
node secops-api-check.mjs --only vulnerabilities --verbose
node secops-api-check.mjs --json > check.json
```
PASS = works · DENIED = outside your token's reach (expected for read/write tokens on org-admin areas) ·
NOT FOUND = the sample id does not apply · N/A = feature not configured on this cell · FAIL = a real problem (exit 1).

## 2. All operations in Postman / Insomnia / Bruno / VS Code
`secops.postman_collection.json` (import; set collection variables `baseUrl`, `token`, and the ids) and
`secops.http` (VS Code REST Client / JetBrains HTTP client). Regenerate after upgrades:
`node generate-collection.mjs`.

## 3. Everyday calls
```bash
# who am I · my organizations
curl -s -H "$H" $SECOPS_URL/api/v1/me
curl -s -H "$H" $SECOPS_URL/api/v1/organizations
ORG=<id>; PROJ=<id>; SVC=<id>; ENV=<id>

# projects, services, environments
curl -s -H "$H" $SECOPS_URL/api/v1/organizations/$ORG/projects
curl -s -H "$H" $SECOPS_URL/api/v1/projects/$PROJ/services
curl -s -H "$H" $SECOPS_URL/api/v1/services/$SVC/environments

# what runs where (releases, images, environments joined)
curl -s -H "$H" $SECOPS_URL/api/v1/services/$SVC/inventory
curl -s -H "$H" $SECOPS_URL/api/v1/projects/$PROJ/graph

# vulnerabilities
curl -s -H "$H" "$SECOPS_URL/api/v1/organizations/$ORG/findings?severity=critical,high&status=open"
curl -s -H "$H" "$SECOPS_URL/api/v1/organizations/$ORG/findings?kev=true"
curl -s -H "$H" $SECOPS_URL/api/v1/organizations/$ORG/findings/summary
curl -s -H "$H" $SECOPS_URL/api/v1/projects/$PROJ/findings/environments          # per environment
curl -s -H "$H" "$SECOPS_URL/api/v1/projects/$PROJ/findings/trend?days=30"
curl -s -H "$H" "$SECOPS_URL/api/v1/projects/$PROJ/code-findings?kind=secret"      # secrets & IaC
curl -s -H "$H" -X PATCH -H 'Content-Type: application/json' \
     -d '{"status":"accepted","note":"not reachable"}' $SECOPS_URL/api/v1/findings/<findingId>   # write token

# SBOMs
curl -s -H "$H" $SECOPS_URL/api/v1/services/$SVC/sboms
curl -s -H "$H" -o sbom.cdx.json $SECOPS_URL/api/v1/sboms/<sbomId>/download
curl -s -H "$H" "$SECOPS_URL/api/v1/organizations/$ORG/components?q=openssl"

# risk
curl -s -H "$H" $SECOPS_URL/api/v1/organizations/$ORG/risk

# delivery (write token): record a deployment — a new version becomes a release
curl -s -H "$H" -X POST -H 'Content-Type: application/json' \
     -d '{"version":"1.9.3","imageRef":"registry/app@sha256:…","commitSha":"<sha>","source":"api"}' \
     $SECOPS_URL/api/v1/environments/$ENV/deployments

# pipelines & jobs
curl -s -H "$H" $SECOPS_URL/api/v1/projects/$PROJ/jobs
curl -s -H "$H" $SECOPS_URL/api/v1/organizations/$ORG/jobs/active

# audit (org admins / sudo)
curl -s -H "$H" "$SECOPS_URL/api/v1/organizations/$ORG/audit-events?limit=50"
```
The same with the CLI: `SECOPS_TOKEN=spt_… matelot request GET /api/v1/organizations/$ORG/findings/summary`.

## 4. Diagnose release / image / environment links
```bash
node secops-diagnose.mjs --service demo      # by name, slug or id; without --service: every service with deployments
```
Per service: current deployment of every environment (release + image linked or NOT LINKED, reference, source),
releases (commit, images, where they run), images (last sync, errors, connection), last deployments, and a
**Problems** list with the cause and the fix (old CLI on the runner, registry never read, missing connection,
no SBOM for what runs, release without commit, …). Exit code 1 when problems are found.
