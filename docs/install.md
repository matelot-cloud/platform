# Install Matelot

Matelot runs as **one cell per organization** in your own Kubernetes cluster: the API, the worker, the web app, managed
runners, a container registry, Postgres, Redis and Keycloak, installed from one Helm chart. Nothing is shared with
anyone else and nothing leaves the cluster except the integrations you connect. This guide takes you from an empty
namespace to the first administrator logged in, with backups on.

## 1. Requirements

| Need | Notes |
| --- | --- |
| Kubernetes 1.28 or newer, `kubectl` and Helm 3.12+ | any conformant distribution; tested on kind, EKS, GKE and AKS storage defaults |
| An ingress controller (class `nginx` by default) | the chart creates three Ingresses per cell |
| cert-manager with a `ClusterIssuer`, **or** your own TLS Secrets | hostnames `<slug>.<domain>`, `auth-<slug>.<domain>`, `registry-<slug>.<domain>` |
| A DNS record for those hostnames (a wildcard `*.<domain>` is simplest) | |
| A default StorageClass | Postgres, the registry and backups use volumes; `WaitForFirstConsumer` classes are fine |
| Outbound access to `ghcr.io` | images and the chart are public packages; mirror them for air-gapped clusters |
| Resources for a small cell | about 2 vCPU and 5 GiB of memory requested across all components; Keycloak is the largest |

Optional: an S3-compatible bucket for off-site backups, an SMTP relay for e-mail notifications, a GitHub App for
GitHub repositories (any Git host also works with tokens).

## 2. Choose the cell's values

```bash
helm show values oci://ghcr.io/matelot-io/charts/secops-cell --version 0.1.0 > values.yaml
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

Images are `ghcr.io/matelot-io/{api,worker,web,runner}` at the chart's `appVersion`; leave the `image` blocks alone
unless you mirror them. Everything else (replicas, resources, managed runner count, SMTP via `api.extraEnv`) has a
documented default in `values.yaml`.

## 3. Install

```bash
helm install acme oci://ghcr.io/matelot-io/charts/secops-cell --version 0.1.0 \
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

## 4. First login and identity

1. Open `https://auth-acme.platform.example.com` as the Keycloak admin (`keycloak.adminPassword`), realm `platform`,
   and add your identity provider (SAML or OIDC: Entra ID, Okta, Google Workspace…). Users are created on first
   login; the e-mail address is what Matelot keys users on.
2. Open `https://acme.platform.example.com` and log in as one of `tenant.adminEmails`: that first login grants the
   administrator role on the root organization. Invite the team from **Members**.
3. The Overview shows the organization setup: connect source code, check the managed runner, alerts, team. From
   there, create a project and a service, attach a repository and run the security pipeline.

For a quick evaluation without an identity provider, `keycloak.seedUsers` creates local users (and
`keycloak.allowPasswordGrant: true` lets the CLI log in with a password); remove both for production.

## 5. The CLI

```bash
npm install -g "github:matelot-io/setup-cli#v2"   # or: uses: matelot-io/setup-cli@v2 in GitHub Actions
matelot login --url https://acme.platform.example.com
matelot whoami
```

CI pipelines authenticate with signed CI tokens (created in the web app under Access tokens), never with a user
password: see the CI/CD integration page.

## 6. Backups

With `backup.enabled` the cell backs itself up on the schedule: `pg_dump` of the platform and Keycloak databases plus
the cell's secrets, as one archive on the backups volume and, if configured, in your S3 bucket. The archive
contains the encryption key and passwords: restrict the bucket and the volume to the cell's operators.

Restore, including rebuilding a cell on a new cluster, is described on the Backup and restore page. The order
matters there: the secrets must be restored **before** `helm install`, so the restored data can be decrypted.

## 7. Upgrades

Each release ships the four images and the chart at the same version. To upgrade:

```bash
helm upgrade acme oci://ghcr.io/matelot-io/charts/secops-cell --version 0.2.0 \
  --namespace tenant-acme -f values.yaml
```

Take a backup first (the CronJob, or a manual job as above). Migrations run in the API's init container before the
new API starts. An image release rolls only the api, worker, web and runner pods; Postgres, Keycloak, Redis and the
registry keep running. Release notes and image digests are published with every release at
https://github.com/matelot-io/matelot/releases; images and the chart are signed with cosign (keyless, GitHub OIDC)
and carry SBOM attestations.

## 8. Removing a cell

```bash
helm uninstall acme --namespace tenant-acme     # keeps the volumes (databases, registry, backups) and the secrets
kubectl delete namespace tenant-acme            # removes everything
```
