# Backup and restore of a tenant cell

A cell's state lives in three places: the **platform database** (everything the product shows), the **Keycloak
database** (users, realm, sessions) and a handful of **Kubernetes Secrets**, one of which, the cell encryption key, is
the only way to read the stored connection credentials (GitHub tokens, registry passwords, Jira tokens, SMTP…). A
backup without the key restores a cell whose connections all say "cannot decrypt".

The chart ships a scheduled backup that captures all three into one archive; two operator scripts run a backup on
demand, download archives and restore them.

**Where the scripts are.** `scripts/cell-backup.sh` and `scripts/cell-restore.sh` are in the `scripts/` folder of
[matelot-cloud/helm-charts](https://github.com/matelot-cloud/helm-charts) (next to the chart; they only need `kubectl`,
`helm`, `bash` and `python3`). The `make backup TENANT=acme` / `make restore …` shorthands used on this page are the
platform repository's Makefile and expand to `scripts/cell-backup.sh -r acme -n tenant-acme -d ./backups` and
`scripts/cell-restore.sh -r acme -n tenant-acme ARCHIVE`; `make deploy` stands for `helm upgrade --install`.

## What is in an archive

`<slug>-<UTC stamp>.tar.gz` (plus `.sha256`):

```
acme-20261009T021700Z/
  manifest.txt                  cell, time, databases, pg_dump and server versions
  db/platform.dump              pg_dump --format=custom (compressed, restorable with pg_restore)
  db/keycloak.dump
  secrets/acme-cell-key/CELL_ENCRYPTION_KEY
  secrets/acme-managed-runner/MANAGED_RUNNER_SECRET
  secrets/acme-registry/{registry.key,registry.crt,REGISTRY_EVENTS_SECRET,REGISTRY_HOST,…}
  secrets/acme-postgres/{POSTGRES_DB,POSTGRES_USER,POSTGRES_PASSWORD}
  secrets/acme-keycloak/{KC_BOOTSTRAP_ADMIN_*,KC_DB_*}
  secrets/acme-api-secrets/{DATABASE_URL,REDIS_URL,GITHUB_APP_*}
```

**Not included:** the registry's image blobs (PVC `<release>-registry`). Images are rebuildable from source and the
platform re-scans what is pushed; if you need them kept, back the registry's volume up with your storage's snapshots or
run the registry on object storage. Redis holds only queues and caches.

**The archive is sensitive.** It contains the encryption key, database passwords and the Keycloak admin password.
Keep the PVC and the bucket restricted to the operators of the cell, turn on server-side encryption on the bucket, and
never attach an archive to a ticket.

## Turning backups on

```yaml
backup:
  enabled: true
  schedule: "17 2 * * *"      # cron, UTC
  retentionDays: 14           # archives older than this are pruned from the PVC
  pvc: { enabled: true, size: 10Gi }
  s3:                         # optional off-site copy of every archive
    enabled: true
    bucket: acme-cell-backups
    prefix: cells/acme
    region: eu-central-1
    credentialsSecret: ""     # Secret with AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, or empty for IRSA / workload identity
    endpoint: ""              # S3-compatible endpoint for MinIO / Ceph
```

`make deploy` (or `helm upgrade`) creates the CronJob `<release>-backup`, the PVC `<release>-backups` (kept on
uninstall) and the script ConfigMap. On a StorageClass with `volumeBindingMode: WaitForFirstConsumer` (kind, EKS gp3,
GKE, AKS defaults) that PVC stays **Pending until the first backup runs** — normal, but it means `helm … --wait` on
this chart waits for it: do not pass `--wait`; when the pods are Running, run the first backup
(`kubectl -n <ns> create job <release>-backup-first --from=cronjob/<release>-backup`, or `scripts/cell-backup.sh`). The job runs `pg_dump` with the chart's own Postgres image, so client and server
versions match. With S3, the dump is an init container and the upload the main container, so an upload never starts
before the dump has finished. Retention on S3 is the bucket's lifecycle rule; the chart does not delete from buckets.

For an **external database** (`postgres.bundled=false`) the job dumps the platform database through the API's
`DATABASE_URL`. The Keycloak database of an external server is not dumped: rely on the managed database's own
snapshots, which you should have anyway in that setup, or point a second CronJob at it.

Verify the first run before trusting the schedule:

```
make backup TENANT=acme                 # runs the job now, waits, downloads the archive to ./backups and checks its sha256
scripts/cell-backup.sh -r acme -n tenant-acme --list
```

Both need `kubectl` access to the namespace. `--download` and `--list` use a short-lived pod that mounts the PVC, so
they need `backup.pvc.enabled`.

## Restoring

Everything goes through `scripts/cell-restore.sh` (`make restore TENANT=acme ARCHIVE=…`). It verifies the checksum,
shows the manifest and asks for confirmation (`--yes` to skip), then:

1. recreates every Secret from the archive, with Helm's ownership labels so a later `helm upgrade` or `helm install`
   adopts them and, thanks to the chart's lookup-reuse, keeps their values;
2. scales the API, worker, Keycloak and managed runners to 0 and waits for their pods to go;
3. copies the dumps into the Postgres pod and, for each database, checks that the dump is readable, drops and recreates
   the database, and runs `pg_restore`; a corrupt dump stops the restore before anything is dropped;
4. scales everything back to the replica counts it found and waits for the API, whose init container applies any
   migrations newer than the backup.

If anything fails the workloads are scaled back up (the EXIT trap), so a failed restore leaves the cell running on
whatever the databases hold at that point: the old data when the failure was before the drop, so check the output.

### Case 1: roll back the data of a running cell

```
make restore TENANT=acme ARCHIVE=backups/acme-20261009T021700Z.tar.gz
```

Expect a few minutes of downtime: the cell is down from step 2 to step 4. Users' sessions survive only if the Keycloak
dump is from the same realm, which it is for the cell's own backups.

### Case 2: rebuild the cell on a new cluster (disaster recovery)

The order matters: the Secrets must exist **before** the first `helm install`, otherwise the chart generates a fresh
encryption key and the restored connections cannot be decrypted.

```
scripts/cell-restore.sh -r acme -n tenant-acme --secrets-only backups/acme-20261009T021700Z.tar.gz
make deploy TENANT=acme          # same values as before: slug, domain, images
scripts/cell-restore.sh -r acme -n tenant-acme --databases-only backups/acme-20261009T021700Z.tar.gz
```

`--secrets-only` creates the namespace's Secrets (`kubectl create namespace tenant-acme` first if it does not exist).
Then point DNS at the new ingress and re-register any self-hosted runners whose tokens were not in the backup
(managed runners pick up the restored `MANAGED_RUNNER_SECRET` by themselves).

### Case 3: external database

With `postgres.bundled=false` there is no Postgres pod. Stop the API, worker and Keycloak (`kubectl scale … --replicas=0`),
then from a machine that reaches the server:

```
tar -xzf acme-20261009T021700Z.tar.gz
PGHOST=globex-db.internal PGUSER=platform PGPASSWORD=… deploy/helm/secops-cell/files/restore-db.sh acme-20261009T021700Z/db
```

and scale the workloads back. `restore-db.sh` takes the database names as extra arguments to restore only some of them.

### After any restore

* `scripts/smoke.sh` against the cell (login, create a workspace, read the audit trail).
* Connections page: every connection shows its status and none says "cannot decrypt". If they do, the restored
  `CELL_ENCRYPTION_KEY` is not the one the data was encrypted with: restore the Secrets from the right archive and
  restart the API.
* `matelot runners list`: managed runners online; self-hosted runners may need a new registration token.
* The audit trail records nothing about the restore itself (it happened below the API); note it in your change log.

## Testing the backup

A backup that has never been restored is a hope, not a backup. Once a quarter, or before any risky upgrade:

```
make backup TENANT=acme BACKUP_DIR=./drill
helm install acme-drill deploy/helm/secops-cell -n tenant-acme-drill --create-namespace --set tenant.slug=acme-drill …
scripts/cell-restore.sh -r acme-drill -n tenant-acme-drill ./drill/acme-….tar.gz
```

The drill cell should show the same projects, connections and findings. Uninstall it afterwards and delete its
namespace (the PVCs are kept on uninstall by design).

## Reference

| Piece | Where |
| --- | --- |
| Backup job script | `deploy/helm/secops-cell/files/backup.sh` (ConfigMap `<release>-backup-script`) |
| In-database restore | `deploy/helm/secops-cell/files/restore-db.sh` |
| Operator scripts | `scripts/cell-backup.sh`, `scripts/cell-restore.sh`; `make backup`, `make restore` |
| Chart values | `backup.*` in `values.yaml`; example in `values-production.example.yaml` |
