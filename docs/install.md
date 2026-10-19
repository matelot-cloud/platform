# Install Matelot

Matelot runs as **one cell per organization** on infrastructure you control: the API, the worker, the web app, a
managed runner, a container registry, Postgres, Redis and Keycloak. Nothing is shared with anyone else and nothing
leaves the cell except the integrations you connect. Two ways to install it:

| | **Option A — Docker Compose** (recommended to start) | **Option B — Kubernetes (Helm)** |
| --- | --- | --- |
| For | evaluation, small teams, one host | production, several teams, your platform standards |
| Needs | Docker 24+ with Compose v2, 2 vCPU / 4 GB, a port (80/443), optionally a DNS name | a cluster, ingress, TLS, storage class, a wildcard DNS record |
| Time to first login | about five minutes | an afternoon the first time |
| Availability | single host; restart = short downtime | replicas for the API and web, Postgres on a volume or a managed database |
| TLS | automatic (Let's Encrypt via Caddy) with a real domain; plain HTTP on localhost | cert-manager or your own certificates |
| Backups | `cell-backup.sh --compose` (databases + secrets + registry blobs), cron on the host | CronJob in the chart to a volume and/or S3 |
| Upgrades | change `MATELOT_VERSION`, `docker compose pull && up -d` | `helm upgrade --version` |
| When to move | when you need HA, more than one runner pool on the same host, or company Kubernetes policies — a Compose backup restores into a Helm cell (same archive format) | |

Both use the same images (`ghcr.io/matelot-cloud/{api,worker,web,runner}`), the same release, and the same
backup archive, so you can start with Compose and move later without losing anything.

---

## Option A: Docker Compose

### A1. Requirements

- Docker Engine 24 or newer with the Compose plugin v2 (`docker compose version`), on Linux, macOS or WSL 2.
- 2 vCPU and 4 GB of memory (the stack is limited to about 4 GB; Keycloak is the largest part), 20 GB of disk.
- Ports 80 and 443 free (configurable), plus 5000 when you use the registry on localhost.
- For HTTPS: a DNS name for the host (`matelot.example.com`) **and** `registry.matelot.example.com`, both pointing at
  it; Caddy obtains Let's Encrypt certificates on first start. Without a domain everything runs on `http://localhost`.

### A2. Start it

```bash
git clone --depth 1 https://github.com/matelot-cloud/matelot && cd matelot/docker   # or download the docker/ folder
cp .env.example .env
# edit .env: MATELOT_DOMAIN (keep localhost to try it), MATELOT_ADMIN_EMAIL, optionally MATELOT_ADMIN_PASSWORD
docker compose up -d
docker compose logs -f welcome          # prints the URL and the administrator login once the cell answers
```

The first start pulls the images, generates every secret (database and Keycloak passwords, the cell encryption key,
the registry signing key, the managed-runner secret) into the `config` volume, runs the database migrations,
imports the Keycloak realm with the first administrator, and starts the managed runner. Nothing in the files is a
default password. Two to five minutes later `welcome` prints:

```
 Matelot is up:    http://localhost
 Sign in as:       admin@localhost
 Password:         <generated>
 Registry:         localhost:5000
```

Sign in with that e-mail and password (`docker compose logs welcome` shows them again; `docker compose run --rm
init show` prints them from the volume). The first login of `MATELOT_ADMIN_EMAIL` becomes administrator of the
root organization; invite the team from **Members**, or connect your identity provider in Keycloak
(`<url>/auth/admin/`, user `admin`, password in the `config` volume under `secrets/keycloak/`).

Check it from your machine:

```bash
npm install -g https://github.com/matelot-cloud/setup-cli/releases/latest/download/matelot-cli.tgz
matelot login --url http://localhost
matelot doctor                   # API, version, login, organization, runners online, registry
matelot registry login           # docker login to the cell's registry with your credentials
matelot registry info            # host and the repository pattern: <workspace>/<team>/<project>/<service>:<tag>
docker push "$(matelot registry path --service <serviceId>)":1   # prints host + path; any other repository name is refused
```

### A3. Settings (.env)

| Variable | Default | What |
| --- | --- | --- |
| `MATELOT_VERSION` | the release the file shipped with | image tag of the four Matelot images — the bare version (`0.1.0`, `0.1.0-rc.8`), not the `v…` git tag (images carry both); change it to upgrade |
| `MATELOT_DOMAIN` | `localhost` | hostname users open; a real name switches to HTTPS and `registry.<domain>` |
| `MATELOT_ACME_EMAIL` | empty | Let's Encrypt contact |
| `MATELOT_ADMIN_EMAIL` / `MATELOT_ADMIN_PASSWORD` | `admin@localhost` / generated | the first administrator (password set here only before the first start) |
| `MATELOT_ORG_SLUG` / `MATELOT_ORG_NAME` | `main` / `My organization` | the root organization (slug is permanent) |
| `MATELOT_HTTP_PORT` / `MATELOT_HTTPS_PORT` / `MATELOT_REGISTRY_PORT` | 80 / 443 / 5000 | published ports |
| `MATELOT_LICENSE` | empty | licence key (Free tier when empty; entitlements arrive with the commercial release) |
| `MATELOT_BACKUP_RETENTION_DAYS` | 14 | archives kept on the backups volume |
| `MATELOT_THEME_LOGO` / `MATELOT_THEME_PRIMARY_COLOR` | empty | the sign-in page's logo (URL or data: URI) and button / link colour (see *Branding the sign-in page* below) |

Changing `MATELOT_DOMAIN` (or the scheme) after the first start is just `docker compose up -d`: Keycloak imported the
realm once, so the one-shot `realm-sync` service updates the realm's redirect URIs and `sslRequired` through the admin
API on every start (users untouched; `docker compose logs realm-sync`). Everything else regenerates on every start.

### A4. Backups and restore

```bash
scripts/cell-backup.sh --compose . -d ./backups        # pg_dump of both databases + secrets + registry blobs → one archive
scripts/cell-backup.sh --compose . --list              # archives on the backups volume
scripts/cell-restore.sh --compose . ./backups/main-20261012T140000Z.tar.gz   # replaces the cell's data with the archive
```

Schedule it with cron on the host (`17 2 * * * cd /opt/matelot/docker && scripts/cell-backup.sh --compose . -d /backups`).
The archive is the same format as the Kubernetes backup, so it restores into a Helm cell too (registry blobs are
restored only into Compose cells). The archive contains the encryption key and every password: keep it where only the
cell's operators can read it. Rebuilding on a new host: copy the `docker/` folder and `.env`, then
`cell-restore.sh --compose . ARCHIVE` — it recreates the volumes, restores the secrets first, then the databases.

### A5. Upgrades and rollback

```bash
# edit .env: MATELOT_VERSION=0.2.0
scripts/cell-backup.sh --compose . -d ./backups
docker compose pull && docker compose up -d           # migrations run before the new API starts
matelot doctor
```

Only the four Matelot services restart; Postgres, Keycloak, Redis and the registry keep running. Rollback: set the
previous `MATELOT_VERSION` and `docker compose up -d` — this works as long as the newer release added no database
migration (the release notes say so); otherwise restore the backup taken before the upgrade, then roll the version
back. Release notes and image digests: https://github.com/matelot-cloud/matelot/releases.

### A6. Removing it

```bash
docker compose down          # stops the cell, keeps every volume (data, secrets, certificates)
docker compose down -v       # removes everything
```

---

## Option B: Kubernetes (Helm)

### B1. Requirements

| Need | Notes |
| --- | --- |
| Kubernetes 1.28 or newer, `kubectl` and Helm 3.12+ | any conformant distribution; tested on kind, EKS, GKE and AKS storage defaults |
| An ingress controller (class `nginx` by default) | the chart creates three Ingresses per cell |
| cert-manager with a `ClusterIssuer`, **or** your own TLS Secrets | hostnames `<slug>.<domain>`, `auth-<slug>.<domain>`, `registry-<slug>.<domain>`. **TLS is mandatory for any hostname other than `localhost`:** browsers treat only `https://` and `localhost` as secure contexts, and the Keycloak login page needs one (`Crypto.subtle is available only in secure contexts`). With `ingress.tls: false` on a real hostname the API and the CLI work but nobody can sign in with a browser; the chart says so in its install notes. For a local cluster, a self-signed cert-manager issuer is enough (click through the certificate warning, or trust the local CA once) |
| A DNS record for those hostnames (a wildcard `*.<domain>` is simplest) | |
| A default StorageClass | Postgres, the registry and backups use volumes; `WaitForFirstConsumer` classes are fine |
| Outbound access to `ghcr.io` | images and the chart are public packages; mirror them for air-gapped clusters |
| Resources for a small cell | about 2 vCPU and 5 GiB of memory requested across all components; Keycloak is the largest |

Optional: an S3-compatible bucket for off-site backups, an SMTP relay for e-mail notifications and member
invitations (without one, invitation and password-reset links are shown once to copy), a GitHub App for
GitHub repositories (any Git host also works with tokens).

### B2. Choose the cell's values

```bash
helm show values oci://ghcr.io/matelot-cloud/charts/secops-cell --version 0.1.0 > values.yaml
```

The settings that matter for a first install:

```yaml
tenant:
  slug: acme                      # DNS label; hostnames, namespace and the root organization are derived from it
  name: "ACME Corporation"
  domain: platform.example.com    # app: acme.platform.example.com · auth: auth-acme.… · registry: registry-acme.…
  adminEmails: ["ciso@acme.com"]  # the first login of these e-mails becomes administrator of the root organization

ingress:
  className: nginx
  tls: true
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt

postgres:
  bundled: true                   # in-cluster Postgres with a volume; or bundled: false + externalUrl for a managed database
  password: "<generate one>"
keycloak:
  adminPassword: "<generate one>" # the Keycloak admin console (auth-acme.…); users come from your identity provider
  allowPasswordGrant: false
  seedUsers: []

backup:
  enabled: true
  schedule: "17 2 * * *"          # daily, UTC
  pvc: { enabled: true, size: 20Gi }
  s3:                             # optional off-site copy
    enabled: false
```

Images are `ghcr.io/matelot-cloud/{api,worker,web,runner}` at the chart's `appVersion`; leave the `image` blocks alone
unless you mirror them. Everything else (replicas, resources, managed runner count, SMTP via `api.extraEnv`) has a
documented default in `values.yaml`.

**Branding the sign-in page.** Sign-in, OTP, password-reset and consent pages are Keycloak's, rendered with the
cell's `matelot` login theme: your organization's name as the heading and in the tab title, the product logo, the
app's colours in light and dark mode. To show your own logo and colour instead, set `keycloak.theme.logo` (a URL or
`data:` URI) and `keycloak.theme.primaryColor` (`primaryColorHover` optional) in the values file — on Compose
`MATELOT_THEME_LOGO` / `MATELOT_THEME_PRIMARY_COLOR` in `.env`; `keycloak.theme.enabled: false` restores the stock
Keycloak look. The theme overrides no Keycloak template, so Keycloak upgrades keep working.

Member management needs nothing extra: with the bundled Keycloak the API reaches its admin API in-cluster
(`KEYCLOAK_ADMIN_URL`, set by the chart and by Compose) to create invited users and set passwords. Optional API
settings: `SERVICE_ACCOUNT_TOKEN_MAX_DAYS` (longest service-account token, default 365) and
`MATELOT_FEATURES_DISABLED` (comma-separated capabilities to turn off, see [Roles](roles.md)).

### B3. Install

```bash
helm install acme oci://ghcr.io/matelot-cloud/charts/secops-cell --version 0.1.0 \
  --namespace tenant-acme --create-namespace -f values.yaml
kubectl -n tenant-acme get pods -w
```

The first start takes a few minutes: Keycloak imports its realm, the API's init container runs the database
migrations, the managed runner registers once the API answers. Do not use `helm install --wait` with backups on a
PVC whose StorageClass binds on first use (kind, EKS gp3, GKE, AKS defaults): that PVC stays Pending until the
first backup mounts it and `--wait` would wait for it. Instead, when every pod is `Running`:

```bash
kubectl -n tenant-acme create job acme-backup-first --from=cronjob/acme-backup   # first backup, binds the volume
kubectl -n tenant-acme logs job/acme-backup-first -f
```

The chart generates and keeps its own secrets (the encryption key for stored credentials, the registry token key
pair, the managed-runner secret); they survive upgrades and are part of every backup.

### B4. First login and identity

1. The administrators in `tenant.adminEmails` already exist in Keycloak: the install (and every upgrade) seeds the
   missing ones with a temporary password, kept in the release's Secret — the first login asks for a new one:
   ```bash
   kubectl -n tenant-acme get secret acme-keycloak -o jsonpath='{.data.SEED_ADMIN_PASSWORD}' | base64 -d; echo
   ```
   (`keycloak.seedAdminPassword` sets it explicitly; `keycloak.seedAdmins: false` turns the seeding off; users that
   exist are never modified.) Open `https://acme.platform.example.com` and sign in: that first login grants the
   administrator role on the root organization. Invite the team from **Members**.
2. For everyone else, open `https://auth-acme.platform.example.com` as the Keycloak admin (`keycloak.adminPassword`),
   realm `platform`, and add your identity provider (SAML or OIDC: Entra ID, Okta, Google Workspace…). Users are
   created on first login; the e-mail address is what Matelot keys users on.
3. The Overview shows the organization setup: connect source code, check the managed runner, alerts, team. From
   there, create a project and a service, attach a repository and run the security pipeline.

For a quick evaluation without an identity provider, `keycloak.seedUsers` creates local users (and
`keycloak.allowPasswordGrant: true` lets the CLI log in with a password); remove both for production.

### B5. The CLI

```bash
npm install -g https://github.com/matelot-cloud/setup-cli/releases/latest/download/matelot-cli.tgz   # pinned: .../releases/download/vX.Y.Z/matelot-cli-X.Y.Z.tgz · GitHub Actions: uses: matelot-cloud/setup-cli@v2
matelot login --url https://acme.platform.example.com
matelot whoami
```

CI pipelines authenticate with signed CI tokens (created in the web app under Access tokens), never with a user
password: see the CI/CD integration page.

### B6. Backups

With `backup.enabled` the cell backs itself up on the schedule: `pg_dump` of the platform and Keycloak databases plus
the cell's secrets, as one archive on the backups volume and, if configured, in your S3 bucket. The archive
contains the encryption key and passwords: restrict the bucket and the volume to the cell's operators.

Restore, including rebuilding a cell on a new cluster, is described on the Backup and restore page. The order
matters there: the secrets must be restored **before** `helm install`, so the restored data can be decrypted.

### B7. Upgrades

Each release ships the four images and the chart at the same version. To upgrade:

```bash
helm upgrade acme oci://ghcr.io/matelot-cloud/charts/secops-cell --version 0.2.0 \
  --namespace tenant-acme -f values.yaml
```

Take a backup first (the CronJob, or a manual job as above). Migrations run in the API's init container before the
new API starts. An image release rolls only the api, worker, web and runner pods; Postgres, Keycloak, Redis and the
registry keep running. Release notes and image digests are published with every release at
https://github.com/matelot-cloud/matelot/releases; images and the chart are signed with cosign (keyless, GitHub OIDC)
and carry SBOM attestations.

### B8. Removing a cell

```bash
helm uninstall acme --namespace tenant-acme     # keeps the volumes (databases, registry, backups) and the secrets
kubectl delete namespace tenant-acme            # removes everything
```
