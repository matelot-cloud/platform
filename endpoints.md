# Endpoints of a cell

Every cell exposes exactly three public hostnames, all TLS, no ports:

| Surface | Hostname | Used by |
|---|---|---|
| Web app + API (`/api/v1`) | `https://<slug>.<domain>` | browsers, runners (`RUNNER_URL=https://<slug>.<domain>/api/v1`), CI (`SECOPS_URL`), webhooks |
| Container registry | `https://registry-<slug>.<domain>` | `docker login/push/pull`, runners scanning images, clusters pulling environment images |
| Identity (Keycloak) | `https://auth-<slug>.<domain>` | browser login (OIDC), the API (JWKS) |

`<slug>` is the customer (`acme`), `<domain>` the operator's cell domain (`secops.example.com`). One
wildcard certificate `*.secops.example.com` (or cert-manager per host) covers all three, because every
name is a single level under the domain. The Helm chart derives all URLs from `tenant.slug` and
`tenant.domain`: token realm, registry notifications, OIDC issuer, `WEB_BASE_URL`, GitHub App callback.

Provisioning a cell therefore needs from the operator: three DNS records (or a wildcard), a TLS
issuer, and `helm install` (M12 automates this in the cell provisioning flow). Nothing about ports or
hostnames is configured by teams: the UI, the CI snippets and the CLI print the cell's real URLs.

## Local development
`make dev` / `make web` / `docker compose` use `http://localhost:3000` (API), `:5173` (web),
`:8080` (Keycloak) and `localhost:5000` (registry, `insecure-registries` in Docker Desktop). These
never appear in a deployed cell.
