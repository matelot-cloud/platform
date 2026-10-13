# Releasing Matelot — internal

How a release is cut, what the pipeline publishes, how the public repositories are kept in sync, and how the
cross-repository token is rotated. (The *product* concepts — builds, releases and deployments inside a cell — are in
`builds-releases-deployments.md`, which is the public page.) This file is internal and is not published.

## The repositories

| Repository | Visibility | Holds | Written by |
| --- | --- | --- | --- |
| `matelot-cloud/platform` | private | this monorepo: code, chart, scripts, docs sources, workflows | people |
| `matelot-cloud/matelot` | public | README, EULA, SECURITY, CODE_OF_CONDUCT, SUPPORT, CHANGELOG, issue templates; **issues, discussions, releases**; `docker/` = the Compose stack | people (files), `release.yml` (releases, `docker/`) |
| `matelot-cloud/helm-charts` | public | `charts/secops-cell/` (copy of `deploy/helm/secops-cell`), `scripts/` (cell-backup, cell-restore + lib), README | `release.yml` (chart + scripts), people (README) |
| `matelot-cloud/website` | public, GitHub Pages | landing page sources (`content.json`, template, assets), **generated** `docs/latest/` and `docs/vX.Y/` | people (landing), `docs-sync.yml` + `release.yml` (docs) |
| `matelot-cloud/.github` | public | organization profile, default community files | people |
| `matelot-cloud/setup-cli` | public | the CLI (Apache-2.0): source, compiled dist, examples, `action.yml`, and a GitHub Release per version with the npm package attached — installable with `npm install -g https://github.com/matelot-cloud/setup-cli/releases/latest/download/matelot-cli.tgz` (pinned: `releases/download/vX.Y.Z/matelot-cli-X.Y.Z.tgz`) and usable as `uses: matelot-cloud/setup-cli@v2` (installs the tag's source archive). Never the `github:` git form: npm 10 leaves it as a dangling symlink | `publish-cli.yml` (everything but README) |

Packages (GitHub Packages, `ghcr.io/matelot-cloud/…`): `api`, `web`, `worker`, `runner`, `charts/secops-cell`.

**Rule: nothing in a public repository is edited by hand except what the table says.** The chart folder, the
operator scripts and the generated docs are overwritten on the next release; a fix goes into `platform` and is
released. Issues, discussions and releases live in `matelot-cloud/matelot` and are never mirrored back.

## Cutting a release

1. On `main`, green CI (`ci.yml`: api tests + migrations, web/runner/CLI builds and tests, docs render + link check,
   chart tests, image builds including the worker target).
2. Add the release's section at the top of `CHANGELOG.md`, titled **`## vX.Y.Z — <one line>`**: the release notes are
   that section (`scripts/changelog-section.sh vX.Y.Z` shows what will be published; without a matching heading the
   first section is used with a note — accepted for a pre-release tag; **a final tag without its section fails the
   release job** before anything is published to `matelot`).
3. Bump versions if they changed: `apps/api`, `apps/web`, `apps/runner` `package.json` and `Chart.yaml`
   (`version` / `appVersion`) carry the development version; the pipeline stamps the tag's version on the chart it
   publishes, so these only need to match for `make deploy` on kind. The CLI has its own version and release:
   bump `apps/cli/package.json`, tag `cli-vX.Y.Z` → `publish-cli.yml` builds, tests and publishes the package to
   `matelot-cloud/setup-cli` (compiled `dist/` committed, tags `vX.Y.Z` and the moving `vX`), creates the GitHub
   Release there with the npm package attached, and publishes to npm when `NPM_TOKEN` is set; the `install-test` job
   proves the documented install commands on a clean runner. The tag must equal `apps/cli/package.json` `version`
   (the guard that caught `cli-v2.19.3` vs `2.19.2`).
4. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. A release candidate is `vX.Y.Z-rc.N`: everything is
   published the same way except the `latest` image tags, and the GitHub Release is marked pre-release.
5. Watch `release.yml` (Actions → release). Jobs:
   - **images** (matrix api, web, worker, runner): `docker buildx` for `linux/amd64,linux/arm64`, pushed as
     `X.Y.Z`, `vX.Y.Z` and (final releases) `latest`; `cosign sign` keyless with the workflow's GitHub OIDC
     identity; `syft` SPDX SBOM attached with `cosign attest --type spdxjson`; SBOMs and digests uploaded as
     workflow artifacts. The worker is the `worker` target of `apps/api/Dockerfile`.
   - **chart**: `helm lint`, `helm package --version X.Y.Z --app-version X.Y.Z`, `helm push` to
     `oci://ghcr.io/matelot-cloud/charts`, `cosign sign` of the chart digest, then the chart folder and the two operator
     scripts are copied into a clone of `helm-charts`, committed and tagged `secops-cell-X.Y.Z`.
   - **compose**: `deploy/compose/` plus `cell-backup.sh`, `cell-restore.sh` and their lib are copied into
     `matelot/docker/`, `.env.example` pinned to `MATELOT_VERSION=X.Y.Z`, committed and pushed.
   - **docs**: `tools/docs-site/build.mjs` renders `docs/` into `website/docs/vX.Y/` (major.minor: a patch release
     overwrites its line) and `website/docs/latest/`, runs the website's own test + link check against the result,
     commits and pushes. The website's `pages.yml` deploys on that push.
   - **release**: `gh release create vX.Y.Z --repo matelot-cloud/matelot` with the CHANGELOG section, the image and chart
     digests, the `cosign verify` commands and the SBOM files attached.
6. Check: `helm pull oci://ghcr.io/matelot-cloud/charts/secops-cell --version X.Y.Z`, `docker pull ghcr.io/matelot-cloud/api:X.Y.Z`,
   the release page, https://matelot-cloud.github.io/website/docs/vX.Y/install.html.
7. Upgrade a cell on kind from the published chart (`helm upgrade … oci://… --version X.Y.Z`) before announcing.

### One-time setup (done once per organization)

- **Packages public:** first, Organization → Settings → Packages → *Package creation* → allow **Public** (without it
  the visibility switch below is not offered). GitHub still creates every package private on first push, so after
  the first release, once per package — `api`, `web`, `worker`, `runner`, `charts/secops-cell` — Organization →
  Packages → package → Package settings → Danger zone → Change visibility → Public. Also under *Manage Actions access* make sure the `platform` repository has
  write access (it does when the package was first pushed by its workflow). Until this is done customers get
  `unauthorized` on pull.
- **Pages:** `website` → Settings → Pages → Source: **GitHub Actions** — by hand, *before* the first push of the
  website (until it is set, `pages.yml`'s deploy step fails and the site 404s). GitHub resets this setting to the
  branch build on its own (seen twice after the custom domain was saved; the site then shows the README): `pages.yml`
  puts `build_type=workflow` back before every deploy, and `docs-sync.yml` / `release.yml` send the `docs-synced`
  repository dispatch after pushing docs so the website workflow runs (and heals) even when nothing changed. Never edit
  the custom domain in the Pages UI — `SITE_DOMAIN` is the one setting. Custom domain: set the repository variable
  `SITE_DOMAIN=matelot.cloud` (Settings → Secrets and variables → Actions → Variables), enter the domain under Pages,
  point DNS at GitHub (A/AAAA for the apex or CNAME `matelot-cloud.github.io`). Nothing else changes: the build writes
  `CNAME`, the sitemap and the preview URLs from that variable; links inside the site are relative.
- **Discussions** enabled on `matelot-cloud/matelot`; **private vulnerability reporting** enabled there
  (Settings → Code security → Private vulnerability reporting), because SECURITY.md points to it.
- **The cross-repository token** (next section) stored as a **repository secret on `platform`** (organization
  secrets are not available to private repositories on the GitHub Free plan).

## The cross-repository token: `PUBLIC_REPOS_TOKEN`

`GITHUB_TOKEN` only reaches the repository that runs the workflow and its packages, so the pushes to `website` and
`helm-charts` and `setup-cli` and the release in `matelot` use a fine-grained personal access token stored as the
**repository secret `PUBLIC_REPOS_TOKEN` on `platform`** (platform → Settings → Secrets and variables → Actions →
New repository secret). On the Free plan an organization secret cannot be shared with a private repository, so the
repository secret is the only option; if the organization moves to Team, an organization secret scoped to
`platform` works the same and is easier to rotate.

Create it as a member who can push to the four public repositories (ideally a dedicated machine account
`matelot-release` that is a member of the organization with write access to exactly those repositories):

| Setting | Value |
| --- | --- |
| Token name | `platform-release → public repos` |
| Resource owner | `matelot-cloud` |
| Expiration | 1 year (the maximum; put the date in the team calendar) |
| Repository access | Only select repositories: `matelot-cloud/website`, `matelot-cloud/helm-charts`, `matelot-cloud/matelot`, `matelot-cloud/setup-cli` |
| Repository permissions | **Contents: Read and write** (push commits and tags, create releases and upload assets); **Metadata: Read** (added automatically) |
| Everything else | No access — no Issues, no Pull requests, no Actions, no Administration, no organization permissions |

Organization owners may have to approve the token (Organization → Settings → Personal access tokens) if the
organization requires approval for fine-grained tokens.

### Rotating it

1. Create a new token with the same settings (above). Keep the old one until the new one has been exercised.
2. `platform` → Settings → Secrets and variables → Actions → `PUBLIC_REPOS_TOKEN` → Update → paste the new token.
3. Exercise it: Actions → `docs-sync` → Run workflow (it clones and, if anything changed, pushes to `website`), or
   push a release candidate tag. Green = the new token works.
4. Delete the old token (user → Settings → Developer settings → Fine-grained tokens → Delete).
5. If a token may have leaked: revoke it first, then create and store the new one; the workflows fail until step 2 is
   done, nothing else breaks. The token cannot touch `platform` or the packages.

The same procedure applies at expiry; GitHub e-mails the token owner a week before.

## Keeping the public repositories in sync

| Public content | Source of truth | Sync |
| --- | --- | --- |
| `website/docs/latest/` | `docs/*.md` on `main` | `docs-sync.yml` on every push to `main` that touches `docs/` or `tools/docs-site/` (also by hand: Actions → docs-sync → Run workflow); locally `make docs-sync WEBSITE_DIR=../website` renders into a clone for a preview |
| `website/docs/vX.Y/` | `docs/*.md` at the tag | `release.yml` |
| `website/content.json`, assets, 404 | the website repository itself | by hand, in `website` (a push deploys) |
| `helm-charts/charts/secops-cell`, `helm-charts/scripts` | `deploy/helm/secops-cell`, `scripts/cell-backup.sh`, `scripts/cell-restore.sh`, `scripts/lib/{wait.sh,cellwait.py}` | `release.yml` |
| `helm-charts/README.md`, `LICENSE` | the public repository | by hand |
| `matelot/*` files | the public repository | by hand; `CHANGELOG.md` there gets a short summary per release line, the detailed log stays here |
| GitHub Release in `matelot` | `CHANGELOG.md` section + digests | `release.yml` |
| `matelot/docker/` | `deploy/compose/`, `scripts/cell-backup.sh`, `scripts/cell-restore.sh`, `scripts/lib/{compose.sh,wait.sh,cellwait.py}` | `release.yml` (version stamped into `.env.example`) |
| `setup-cli/*` except README | `apps/cli` (src, **compiled `dist/`**, examples, package.json without `prepare`/devDependencies, tsconfig, action.yml, LICENSE) | `publish-cli.yml` on `cli-v*` tags: push, tags `vX.Y.Z` + moving `v<major>`, then a GitHub Release `vX.Y.Z` in `setup-cli` with `matelot-cli-X.Y.Z.tgz` and `matelot-cli.tgz` (fixed name for `releases/latest/download/`); the `install-test` job then runs the documented commands on a clean runner (pinned asset, latest asset, the major tag's source archive) and checks `matelot --version` / `secops --version` |
| `setup-cli/README.md` | the public repository | by hand |

The docs page list is the `SITE` table in `tools/docs-site/build.mjs`: a new page is added there and in the
section's order; a page not in the table is not published (roadmap, concept, `cell-provisioning.md` — our own
provisioning runbook — and this file stay internal). Public docs may not link into this repository (`../…` links fail the build) because readers cannot open it;
link to the public repositories or the site instead. `make docs-check` is what CI runs.

## Versions, tags and what a customer sees

- Images: `ghcr.io/matelot-cloud/<name>:X.Y.Z` (what the chart pulls: `appVersion`), `vX.Y.Z` (same digest), `latest`.
- Chart: `oci://ghcr.io/matelot-cloud/charts/secops-cell:X.Y.Z`, `appVersion: X.Y.Z` → a customer upgrades images and
  chart together with `helm upgrade --version X.Y.Z`; `image.tag` in values overrides for a hotfix image.
- Docs: `docs/vX.Y/` per release line, `docs/latest/` = `main`; the version switcher is built from the folders.
- The cell reports its version as `APP_VERSION` (`GET /api/v1/meta`, "API x.y.z" in the web footer), set by the chart
  from the image tag.

## Workflow hygiene

- Actions are pinned to the current majors on the Node 24 runtime (checkout v7, setup-node v7, pnpm/action-setup v6,
  upload-artifact v7 / download-artifact v8, setup-helm v5, docker/* v4–v7, deploy-pages v5); `sigstore/cosign-installer`
  stays on **v3** (cosign 2.x) on purpose — v4 installs cosign 3, which signs in the new bundle format that cosign 2
  clients cannot verify; move when customers can be expected to run cosign 3. Runners are pinned to `ubuntu-24.04`
  (`ubuntu-latest` moves to 26.04 on 2026-10-19).
- The runner image builds from `apps/runner` as its context (its Dockerfile copies `.`), the api/worker/web images from
  the repository root; `release.yml` and `ci.yml` carry the context per matrix entry.
- cosign reads Docker's credential store, which `helm registry login` does not write: the chart job logs in with
  `docker/login-action` before pushing and signing (a freshly created private package answers UNAUTHORIZED otherwise).
- Every job has `timeout-minutes` (images 25: a multi-arch build that has not finished by then is hung — the arm64 leg
  under QEMU once ran 3 h 37 min; ci compose 45, the rest 5–25). The worker image is the second target of the api
  Dockerfile and is built in the **api** leg right after the api image on the same builder (`also: worker` in the
  matrix), so its shared stages are cache hits instead of a second full multi-arch build; every image job also uses
  the GitHub Actions cache (`type=gha`, one scope per image, the worker reading the api scope too).
- **A hung or failed image leg is recovered with "Re-run failed jobs"**, not a new tag: the `release` job runs when
  every upstream job succeeded in this or an earlier attempt (`if: !cancelled() && needs.*.result == 'success'`),
  artifacts of earlier attempts stay available, and a pre-check refuses to publish unless all four image digests
  (api, worker, web, runner) are present.
- `publish-cli.yml` creates the pack directory itself (`PACK` job env, `mkdir -p "$PACK" && npm pack
  --pack-destination "$PACK"`). `scripts/check-workflows.sh` (layout CI job, `make check-layout`) fails when a
  regenerated workflow loses any of the above: a job without a timeout, a pack step without the mkdir, a separate worker
  leg, a release job without the re-run guard.

## Local checks before tagging

```bash
pnpm -r typecheck && pnpm -r test && pnpm -r build
make helm-lint          # scripts/chart-test.sh: every configuration, install == upgrade, tag change rolls only app pods, compose copies
deploy/compose/smoke.sh # with local images: MATELOT_VERSION=local MATELOT_REGISTRY_PREFIX=secops in deploy/compose/.env (CI job `compose`)
make docs-check         # docs render + every link resolves
scripts/changelog-section.sh vX.Y.Z
```
