# Builds, releases, deployments — how they connect

## The model
| Concept | What it is | Created by |
|---|---|---|
| **Build** | an image built from a commit (`<registry>/<repo>:<commit>`), identified by its **digest** | a push to the platform registry, or a deployment that reports it |
| **Release** | a version of the service (`1.9.0`), tied to a commit | a deployment that names a version (`matelot deploy --version`), a git tag / GitHub or GitLab release sync, or *Record release* |
| **Deployment** | "this image / release now runs in this environment" | `matelot deploy`, `matelot promote`, a push to an environment repository, Kubernetes sync |

A release does not *have* an environment — a deployment puts it there. One release can run in several
environments (test, then prod, then a DR region); the graph draws **release → image → environment**
for every current deployment.

## Standard flow
```
commit ──build──► image demo:<sha> ──deploy──► dev          (no release: a build of main)
tag v1.9.0-rc1 ──► image …:v1.9.0-rc1 ──deploy──► test       release 1.9.0-rc1 created by the deployment
tag v1.9.0     ──► image …:v1.9.0     ──deploy──► prod       release 1.9.0 created by the deployment
```
Every deploy step reports `--version` (for rc and final), `--image <image>@<digest>` and `--commit`.

## What the platform guarantees
* **A deployment that names a version creates the release** if it does not exist yet (version-like names
  only), with the commit from `--commit` / `SECOPS_COMMIT`; audited as `release.created`. Git tag sync
  later enriches the same release (URL, notes, date) — it no longer depends on webhooks reaching the cell.
* **A digest is one image**, whatever registry or tag it lives under:
  * a deployment reported by digest from a registry the platform has not read yet triggers an immediate
    registry read, and every later sync attaches digest-only deployments to their tag;
  * the security graph, *Vulnerabilities → Running in*, the trend snapshots and the correlation all resolve
    "what runs here" by digest;
  * the same image pushed to several registries is scanned once (one SBOM per digest).
* **Tags link to releases** by version (`v1.9.0` ↔ `1.9.0`), by commit (`<sha>` tags), and by a deployment
  that names both a version and an image.

## Built-in registry: what records a deployment
* `matelot promote` records the deployment itself, the moment the copy is done (no dependency on registry
  notifications reaching the API or on the reconcile loop).
* A real `docker push` into an environment repository is recorded by the registry notification.
* The **reconcile pass** (every 2 minutes, or *POST /organizations/:id/registry/reconcile*) only fills an
  environment that has nothing recorded, or records a tag built **after** the current deployment (a push the
  notification missed). It never overwrites a deployment reported from another registry, by hand or by
  Kubernetes — older tags lying in the environment repository are ignored. All three paths are serialised
  per environment, so they cannot record the same deployment twice.

## Environment lineage (Security graph → Environments)
Per environment, two lanes: **Released** — repository (commit) → release (version tag) → registries holding that
tag → environment; **Running now** — repository (commit of the running build) → image *digest* → registries
holding that digest (the one it was deployed from marked) → environment. Only the digest identifies what runs;
a tag is a pointer that can move. **Drift** is flagged when the lanes disagree: the version tag was rebuilt
after the deployment (`tag_moved`), the tag points to different images in different registries
(`tag_split`), the running digest is in no known registry (`unknown_image`), no release exists for the
deployed version (`no_release`), the running image was never scanned (`not_scanned`), a registry sync fails.
API: `GET /environments/:id/lineage`.

## Where to see it
Releases & images (release card: images + environment chips) · Running now · Security graph (hover a
release) · Vulnerabilities → Running in · Audit (`release.created`, `deployment.recorded`).

