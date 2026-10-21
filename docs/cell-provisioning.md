# Provisioning a tenant cell

Every customer gets one cell: a Helm release of `deploy/helm/secops-cell` in its own namespace `tenant-<slug>`,
with its own API, web app, worker, managed runners, Postgres, Redis, Keycloak, registry and backups. Cells never
share data. This runbook takes a cell from "signed contract" to "customer logged in", and covers upgrades and
decommissioning. The control plane that will automate it later (roadmap step 17) will run the same steps.

## 1. Prerequisites (once per cluster)

| Need | Why | Check |
| --- | --- | --- |
| Kubernetes 1.28+, `kubectl` and `helm` 3 with access | | `kubectl config current-context` |
| An ingress controller, class `nginx` by default | one Ingress per host per cell | `kubectl get ingressclass` |
| cert-manager with a `ClusterIssuer` (e.g. `letsencrypt`) | TLS for `<slug>.<domain>`, `auth-<slug>.<domain>`, `registry-<slug>.<domain>` — **mandatory**: browsers sign in only in a secure context (HTTPS or localhost); with `ingress.tls: false` on a real hostname Keycloak's login page fails with "Crypto.subtle is available only in secure contexts" (preflight warns, the chart's NOTES warn) | `kubectl get clusterissuer` |
| A wildcard DNS record `*.<domain>` → the ingress | one record covers every cell | `dig +short x.<domain>` |
| A default StorageClass (or set `*.storageClassName`) | Postgres, registry, backups | `kubectl get storageclass` |
| The four images: `ghcr.io/matelot-cloud/{api,worker,web,runner}` at the same tag (public packages; a private mirror needs `imagePullSecrets`) | released by `.github/workflows/release.yml` | |
| For backups off-site: an S3 bucket and credentials or pod identity | docs/backup-restore.md | |
| Optional: an SMTP relay for e-mail notifications | `api.extraEnv` SMTP_* | |

Cells are isolated by NetworkPolicy (nothing outside the namespace reaches a cell except the ingress controller),
so the ingress controller's namespace must match `ingress.controllerNamespace` (default `ingress-nginx`).

**Local cluster (kind) with a working browser login.** `scripts/kind-up.sh` creates the cluster with ingress-nginx,
cert-manager (`CERT_MANAGER_VERSION`, default v1.17.2) and a local CA as ClusterIssuer `selfsigned`
(`deploy/kind/cert-manager-selfsigned.yaml`). `cell-provision.sh new` picks that issuer automatically when the current
context is `kind-secops` (`--issuer` overrides), so:

```bash
scripts/kind-up.sh
scripts/cell-provision.sh new --slug acme --name "ACME" --domain platform.local --admin admin@acme.local
# /etc/hosts: 127.0.0.1 acme.platform.local auth-acme.platform.local registry-acme.platform.local
DB_PASSWORD=… KC_ADMIN_PASSWORD=… scripts/cell-provision.sh apply --slug acme
```

gives https://acme.platform.local with a certificate from the local CA. Then, on the machine the **browser** runs on:

- hosts file: `127.0.0.1 acme.platform.local auth-acme.platform.local registry-acme.platform.local` — `/etc/hosts`, and
  on WSL also `C:\Windows\System32\drivers\etc\hosts` (as Administrator), because the Windows browser does not read
  WSL's file;
- the CA: export it once with `kubectl -n cert-manager get secret matelot-dev-ca -o jsonpath='{.data.ca\.crt}' | base64 -d
  > ~/matelot-dev-ca.crt`, then either click through the certificate warning (no flags needed) or trust it — macOS
  `security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db ~/matelot-dev-ca.crt`; Linux copy
  to `/usr/local/share/ca-certificates/` + `update-ca-certificates`; Windows `certutil -addstore -user Root
  matelot-dev-ca.crt` (PowerShell), from WSL `/mnt/c/Windows/System32/certutil.exe -addstore -user Root "$(wslpath -w
  ~/matelot-dev-ca.crt)"`;
- the CLI: Node does not read the OS trust store — `NODE_EXTRA_CA_CERTS=~/matelot-dev-ca.crt matelot login --url
  https://acme.platform.local` (export it in your shell profile for every `matelot` command — a shell that lost it shows
  `matelot doctor` failing at the api check with the TLS error and this hint, the version line reads *skipped*); `docker login
  registry-acme.platform.local` needs the CA in Docker's trust (`/etc/docker/certs.d/registry-acme.platform.local/ca.crt`).

`make deploy TENANT=acme` (the chart with the images from this checkout) uses the same issuer. Switching an installed
cell from `tls: false` to `true` (or changing the domain) is a normal `apply`: the chart's post-upgrade hook
`<release>-realm-sync` updates the Keycloak realm's redirect URIs and `sslRequired` through the admin API — the realm is
imported only once, so without it the login would answer "Invalid parameter: redirect_uri".

## 2. Inputs per cell

| Input | Example | Notes |
| --- | --- | --- |
| slug | `globex` | DNS label, immutable, becomes the namespace, release name, hostnames and root organization slug |
| name | `Globex Corporation` | root organization display name |
| domain | `platform.example.com` | the shared platform domain; hosts are derived from it |
| admin e-mails | `ciso@globex.com` | first login of each becomes ORG_ADMIN of the root organization (`BOOTSTRAP_ADMIN_EMAILS`) |
| image tag | `0.2.0` | one tag for the three images |
| database | bundled or managed | production: managed Postgres, `postgres.bundled=false` + `externalUrl` / `externalKeycloakJdbcUrl` |
| secrets | `DB_PASSWORD`, `KC_ADMIN_PASSWORD`, SMTP password… | environment variables at apply time, never in the values file |
| backups | PVC and/or S3 prefix `cells/<slug>` | on by default in the template |

## 3. Create the cell

```
scripts/cell-provision.sh new --slug globex --name "Globex Corporation" --domain platform.example.com --admin ciso@globex.com
```

writes `deploy/cells/globex.values.yaml` from `deploy/cells/_template.values.yaml`. Edit it: image repositories and
tag, TLS issuer, database (managed in production), backups (S3), SMTP, replicas. Commit it: `deploy/cells/` is
the inventory of cells.

```
export DB_PASSWORD=… KC_ADMIN_PASSWORD=…            # from the secret manager
scripts/cell-provision.sh apply --slug globex --dry-run   # preflight + render, nothing applied
scripts/cell-provision.sh apply --slug globex             # for real
```

`apply` runs a **preflight** (every `${VAR}` placeholder has a value, ingress class and ClusterIssuer exist, whether
the three hostnames resolve yet), fills the placeholders into a temporary copy of the values file, runs
`helm upgrade --install`, **waits for the workloads** with a progress line every 15 s (what is not ready yet, and a
warning the moment something is stuck: ImagePullBackOff, CrashLoopBackOff, a pod Pending for minutes), on a new cell runs the
**first backup** (an existing cell is backed up *before* the upgrade instead), then the **checks**: API and worker rolled out, no restarting pods, the API answers
`/api/v1/health/ready` from inside the cluster (one curl pod retrying with backoff for up to `READY_TIMEOUT` seconds,
default 60 — right after a rollout the Service endpoints are still switching, so the first request may get nothing;
the line says how long readiness took and, on failure, the last HTTP status and body), the backup CronJob exists; it
prints the chart's notes and the handover pointers. `make provision TENANT=globex` is the same thing.

`apply` deliberately does not use helm's own `--wait`. With backups on a PVC and a StorageClass whose
`volumeBindingMode` is `WaitForFirstConsumer` (kind's `standard`, EKS gp3, GKE `standard-rwo`, AKS `managed-csi`),
the backups PVC stays Pending until the first backup Job mounts it, and `helm install --wait` waits for every PVC to
be Bound: a plain `helm install --wait` or `make deploy … --wait` of this chart sits there until its timeout. The
script waits for Deployments and StatefulSets instead, and the first backup it runs binds the PVC.

First boot takes a few minutes: Keycloak imports the realm, the API's init container runs the migrations, the
managed runner registers once the API answers (it retries with backoff).

## 4. Verify

```
scripts/cell-provision.sh check --slug globex
API=https://globex.platform.example.com/api/v1 KC=https://auth-globex.platform.example.com KC_USER=… KC_PASS=… scripts/smoke.sh
make backup TENANT=globex          # the first backup, downloaded and checksum-verified
```

Then open `https://globex.platform.example.com`: the login goes to the cell's Keycloak, where the administrators of
`tenant.adminEmails` already exist — the realm-sync hook seeds the missing ones on every install/upgrade with a
temporary password (`apply` prints how to read it: `kubectl -n tenant-globex get secret globex-keycloak -o
jsonpath='{.data.SEED_ADMIN_PASSWORD}' | base64 -d`); the first login asks for a new one. Existing users are never
modified; `keycloak.seedAdmins: false` leaves user creation to the operator or the IdP. The hook's last run stays as
`job/globex-realm-sync` (`kubectl logs`) — `apply` prints its summary line (`realm-sync: realm platform synced: …`).

## 5. Handover

1. **Identity.** Open `https://auth-globex.platform.example.com` as the Keycloak admin (`KC_ADMIN_PASSWORD`),
   realm `platform`, and add the customer's identity provider (SAML or OIDC: Entra ID, Okta, Google…) with
   "first login flow" creating users. E-mail must be mapped: the platform keys users on it.
2. **First administrator.** Hand the person listed in `tenant.adminEmails` the temporary password from the Secret
   (§4); their first login sets a new password and grants ORG_ADMIN on the root organization (audit events
   `organization.bootstrapped` and `membership.granted`). From there they invite the team (Members).
3. **Setup card.** The Overview shows the organization setup to administrators: connect source code (GitHub App,
   GitLab…), check the managed runner, alerts, team. Service coverage shows what each service still lacks.
4. **Tell them what they own.** Hostnames, the registry (`registry-globex.…`, `matelot registry login`), where backups
   go and how long they are kept, and the support channel.

## 6. Day 2

* **Upgrade one cell:** change the tag in `deploy/cells/<slug>.values.yaml` and `scripts/cell-provision.sh apply
  --slug <slug>` (or `apply --tag X` for a one-off). `apply` takes a **pre-upgrade backup** first (`--no-backup` to
  skip), then upgrades. Migrations run in the API's init container. An image release rolls only the api, worker, web
  and managed-runner pods: Postgres, Keycloak, Redis and the registry keep running (their pod templates carry no
  version label; `make helm-lint` asserts it).
* **Upgrade all cells:** `for f in deploy/cells/*.values.yaml; do s=$(basename "$f" .values.yaml); [ "$s" = _template ] ||
  scripts/cell-provision.sh apply --slug "$s" --tag X; done` — one at a time, checks included, stops at the first
  unhealthy cell.
* **Scale:** `api.replicas`, `web.replicas`, `managedRunners.replicas`; resources per component in the values file.
* **Rotate the Keycloak admin password:** change it in Keycloak, update the secret manager; the chart value is only
  the bootstrap value.
* **Restore:** docs/backup-restore.md.
* **A release left `failed` or `pending-*`** by an interrupted or rejected apply: just run `apply` again. It upgrades
  over `failed` when a good revision exists, rolls `pending-*` back to the last good revision first, and validates the
  rendered chart with `kubectl apply --dry-run=server` before helm touches the release — a chart the API server rejects
  changes nothing. Helm hooks (the `realm-sync` Job) are validated apart, as new objects under a throwaway name: the
  Job from the previous run still exists until helm replaces it and a Job's `spec.template` is immutable, so a dry-run
  apply of it would fail with "field is immutable" on every upgrade. Only a first install whose every revision failed must be removed (`helm uninstall`; the namespace
  and its volumes stay) before applying again.

### Branding the sign-in page

The cell's sign-in, OTP, password-reset and consent pages are Keycloak's own, rendered with the **`matelot` login
theme** that the chart ships: the stock `keycloak.v2` layout and behaviour with our favicon, the product logo above
the form, the tenant name as the heading ("Sign in to Globex Corporation"), the tab title "Globex Corporation ·
Matelot", the web app's palette (light and dark, following the browser's `prefers-color-scheme`) and font. Nothing
in it overrides a Keycloak template, so Keycloak upgrades do not break it. Customers who want their own look set, in
the cell's values file:

```yaml
keycloak:
  theme:
    logo: https://cdn.example.com/brand/mark.png   # or a data: URI; shown 72×72 above the form
    primaryColor: "#0f766e"                        # buttons and links (default: the app's brand blue)
    primaryColorHover: "#115e59"                   # optional, defaults to primaryColor
```

`apply` renders them into the theme's `css/cell.css` and restarts Keycloak (the theme ConfigMap is part of its pod
checksum); `realm-sync` keeps `loginTheme=matelot` set on every run, so a theme shipped with a later release reaches
existing cells too. `keycloak.theme.enabled: false` goes back to the stock Keycloak look. The tenant name on the page
is the realm's display name: it is set from `tenant.name` on install, the old templated form ("… Security Platform")
is migrated once, and a name typed by hand in the Keycloak console is kept. The font loads from Google Fonts; a cell
without internet access falls back to the system font. The Docker Compose stack has the same theme, with
`MATELOT_THEME_LOGO` and `MATELOT_THEME_PRIMARY_COLOR` in `.env`.

If the sign-in page comes up unbranded (stock title "Sign in to <tenant>"), Keycloak could not load the theme — it
says so in exactly one log line, `Failed to find LOGIN theme matelot, using built-in themes`, and otherwise serves the
stock page with HTTP 200. Keycloak resolves a theme as `themes/<name>/<type>/theme.properties`, so the file must be at
`/opt/keycloak/themes/matelot/login/theme.properties` in the pod: `kubectl -n tenant-<slug> exec deploy/<slug>-keycloak
-- find /opt/keycloak/themes/matelot -maxdepth 2` shows what the mount holds. (0.1.0-rc.14 mounted the `login/`
directory's contents one level too high and fell back to the stock theme; the chart test asserts the resolved paths and
CI starts a Keycloak pod with the chart's mount — `scripts/chart-theme-kind-test.sh` — since.) `deploy/compose/
login-page-check.sh <base URL>` checks a running cell's page from outside: title, theme, every asset.

`checks` probes the API from inside the cluster with a short-lived curl pod and a 60 s budget shared between the
curl retries and the pod itself: a pod that gives no verdict (no output — `kubectl run` lost its attach right after
a rollout, the pod was evicted) is one more retry inside the budget, never "unhealthy" by itself; when that
persists for the whole budget the last pod is kept for a moment and its phase, last event and logs are printed.

## 7. Decommission

```
scripts/cell-decommission.sh --slug globex                 # final backup to ./decommissioned/globex, helm uninstall; data kept
scripts/cell-decommission.sh --slug globex --purge         # … and delete the namespace with every volume
```

Without `--purge` the namespace and its PVCs (Postgres, registry blobs, backups) and the kept Secrets stay for the
retention period agreed with the customer; the script lists exactly what remains. `--purge` later (with the release
already gone it skips the backup, deletes the namespace and waits for the PVs to disappear) removes them. Then remove
`deploy/cells/globex.values.yaml`, the DNS records if any were specific, the S3 prefix after retention, and the
customer-side IdP client.

## 8. Conventions

* Namespace `tenant-<slug>`, release `<slug>`, hosts `<slug>.<domain>`, `auth-<slug>.<domain>`,
  `registry-<slug>.<domain>`. One wildcard certificate per cell is not needed: cert-manager issues per host.
* Secrets generated by the chart (encryption key, registry token key pair, events secret, managed-runner secret)
  are created on the first install and reused on every upgrade; they are in every backup. Provide `encryptionKey`
  etc. explicitly only when migrating a cell from elsewhere.
* Resource defaults in the chart fit a small cell on one node; the template sets 20Gi volumes. Size up in the
  values file, never in the chart.

## Reference

| Piece | Where |
| --- | --- |
| Provision / check | `scripts/cell-provision.sh`, `make provision TENANT=…` |
| Decommission | `scripts/cell-decommission.sh`, `make decommission TENANT=…` |
| Cell inventory | `deploy/cells/<slug>.values.yaml` (template `_template.values.yaml`) |
| Chart | `deploy/helm/secops-cell` (`make helm-lint` renders every supported configuration) |
| Backups | docs/backup-restore.md · Managed runners: docs/managed-runners.md · Usage: docs/usage-and-limits.md |
