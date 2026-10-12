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
| cert-manager with a `ClusterIssuer` (e.g. `letsencrypt`) | TLS for `<slug>.<domain>`, `auth-<slug>.<domain>`, `registry-<slug>.<domain>` | `kubectl get clusterissuer` |
| A wildcard DNS record `*.<domain>` → the ingress | one record covers every cell | `dig +short x.<domain>` |
| A default StorageClass (or set `*.storageClassName`) | Postgres, registry, backups | `kubectl get storageclass` |
| The four images: `ghcr.io/matelot-cloud/{api,worker,web,runner}` at the same tag (public packages; a private mirror needs `imagePullSecrets`) | released by `.github/workflows/release.yml` | |
| For backups off-site: an S3 bucket and credentials or pod identity | docs/backup-restore.md | |
| Optional: an SMTP relay for e-mail notifications | `api.extraEnv` SMTP_* | |

Cells are isolated by NetworkPolicy (nothing outside the namespace reaches a cell except the ingress controller),
so the ingress controller's namespace must match `ingress.controllerNamespace` (default `ingress-nginx`).

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
`/api/v1/health/ready` from inside the cluster, the backup CronJob exists; it prints the chart's notes and the
handover pointers. `make provision TENANT=globex` is the same thing.

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

Then open `https://globex.platform.example.com`: the login goes to the cell's Keycloak. Until an IdP is configured
there is no user to log in with on a production cell (`seedUsers: []`), which is the next step.

## 5. Handover

1. **Identity.** Open `https://auth-globex.platform.example.com` as the Keycloak admin (`KC_ADMIN_PASSWORD`),
   realm `platform`, and add the customer's identity provider (SAML or OIDC: Entra ID, Okta, Google…) with
   "first login flow" creating users. E-mail must be mapped: the platform keys users on it.
2. **First administrator.** The person listed in `tenant.adminEmails` logs in; their first login grants ORG_ADMIN on
   the root organization (audit events `organization.bootstrapped` and `membership.granted`). From there they invite the team (Members).
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
