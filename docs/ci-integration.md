# CI/CD integration (signed CI tokens)

Pipelines talk to the platform with **CI tokens**: machine credentials created on a project (or
team / workspace / organization), limited to what a pipeline needs, revocable, audited. Requests are
**signed**, never carry the secret, cannot be replayed or altered:

```
Authorization: SecOps-HMAC-SHA256 keyId=sk_…,ts=<unix>,nonce=<random>,sig=<hex>
sig = HMAC-SHA256(secret, "v1\n" + ts + "\n" + nonce + "\n" + METHOD + "\n" + path + "\n" + sha256hex(body))
```
The cell accepts a timestamp within ±5 minutes and each nonce once (Redis). The secret is shown once
at creation and stored encrypted with the cell key.

## Create a token
Project → Settings → **CI tokens** → New token → choose a preset (*Report releases and deployments*,
*Run security pipelines and gates*, *Everything a pipeline can do*), optional expiry → copy `keyId`
and `secret` into your CI secrets (`MATELOT_KEY_ID`, `MATELOT_SECRET`).

## Use it
**The CLI** (`matelot`, source `apps/cli`, published as the public repository
[matelot-cloud/setup-cli](https://github.com/matelot-cloud/setup-cli); Node ≥ 18, no dependencies, no build on install).
Every CLI release attaches the npm package to a GitHub Release there:

```bash
npm install -g https://github.com/matelot-cloud/setup-cli/releases/latest/download/matelot-cli.tgz          # newest release
npm install -g https://github.com/matelot-cloud/setup-cli/releases/download/v2.22.3/matelot-cli-2.22.3.tgz  # pinned
```

Do not install with the `github:<owner>/<repo>` git form: npm 10 links such an install to its temporary clone
and then deletes it, so `matelot` ends up as a dangling symlink. In GitHub Actions use the same repository as an
action, which installs the CLI at the tag it was used with and exports the variables:

```yaml
- uses: matelot-cloud/setup-cli@v2   # or @v2.22.3
  with:
    url: ${{ vars.MATELOT_URL }}
    key-id: ${{ secrets.MATELOT_KEY_ID }}
    secret: ${{ secrets.MATELOT_SECRET }}
- run: matelot pipeline --service ${{ vars.MATELOT_SERVICE_ID }} --ref ${{ github.sha }} --wait
- run: matelot deploy --env ${{ vars.MATELOT_ENV_PROD }} --version ${{ github.ref_name }} --image $IMAGE

GitLab CI and Bitbucket Pipelines equivalents: `docs/examples/gitlab-ci.yml`, `docs/examples/bitbucket-pipelines.yml`. A complete GitHub workflow (pipeline on every push, dev on main, tag → test → blocking prod gate → prod → signed evidence artifact) is in `docs/examples/github-actions.yml`. The action installs the CLI from the GitHub repository (`npm install -g github:…#ref`), so no npm publish is needed.
```

Releases: `git tag cli-v0.1.0 && git push --tags` runs `.github/workflows/publish-cli.yml`, which
publishes to npm with **provenance** (Sigstore attestation linking the package to the commit and
workflow), so consumers can verify what they run (`npm audit signatures`). Requires an `NPM_TOKEN`
secret (automation token of the npm org) once.

For the rare CI without Node, `tools/secops-ci/secops.sh` (bash + openssl + curl) implements the same protocol (not advertised in the UI):

```yaml
- uses: <org>/secops-platform/tools/secops-ci@main
  with:
    url: https://acme.secops.example.com
    key-id: ${{ secrets.MATELOT_KEY_ID }}
    secret: ${{ secrets.MATELOT_SECRET }}
    command: deploy
    args: --env 3f2a… --version ${{ github.ref_name }} --image ghcr.io/acme/app:${{ github.ref_name }}
```
GitLab CI / Jenkins / anything else: `curl -sSO https://…/secops.sh && bash secops.sh deploy …`.

Commands: `whoami`, `deploy --env <id> --version X [--image ref]`, `release --service <id> --version X`,
`pipeline --service <id> [--template security] [--ref <branch|tag|sha>]`, `sbom --service <id> --file bom.json --target source|image
[--version X] [--image ref]` (upload an SBOM the CI generated itself, e.g. `syft dir:. -o cyclonedx-json=bom.json`
or `syft ghcr.io/acme/app:1.2.0 -o cyclonedx-json=bom.json` with the job's own registry access),
`request METHOD /api/v1/… '<json>'`.

## Network
The CI job needs outbound HTTPS to the cell. Hosted CI runners (github.com) require the cell to be
reachable from the internet (TLS terminates in the cell, so the connection is end-to-end encrypted);
a private cell works with self-hosted CI runners. For customers who require it, the cell ingress can
additionally demand a client certificate (mTLS).

## Built-in registry
Namespaces mirror the platform, like GitLab group paths — no collisions between teams and the path
says who owns the image:

```
<workspace>/<team>/<project>/<service>:<tag>                builds (scanned on every push)
<workspace>/<team>/<project>/<service>/<environment>:<tag>  deployed to that environment
```
Pushing into an environment repository — or `matelot promote --env <id> --tag <tag>`, which copies the
build inside the registry without re-uploading — *is* the deployment; the cluster pulls from the
environment repository. A project CI token may use only its project's namespace.

The repository name is not free-form: it must be the service's path (lower-case slugs), which
`matelot registry path --service <serviceId>` prints; `matelot registry info` shows the host and the pattern. A
`docker push` to any other name — `localhost:5000/my-app:1`, a renamed slug, the wrong team — is refused by the
registry with `insufficient_scope: authorization failed`: the token endpoint grants push only for repositories that
resolve to a service the token may write to. That refusal is the security decision, not a login problem.

**Protected environments** (Environments → Settings → *Protected*): only CI tokens explicitly allowed
for that environment (*Settings → CI tokens → May deploy to*) can push/promote into it or record
deployments there; a build token therefore cannot deploy to production by accident. Give the release
job its own token.

Nothing is hard-coded in pipelines: `matelot registry login` logs Docker in with the CI token, `matelot registry
path --service <id>` prints the build image path (`--env <id>` the environment path), `matelot promote` deploys.
Every environment row in the UI has copy buttons for its registry path and id; templates with the real
values are under Environments → *CI snippet* (GitHub Actions and GitLab CI).

With the preset *Push and pull images* (or *Everything a pipeline can do*), the same CI token is a
Docker credential: `docker login <registry host> -u $MATELOT_KEY_ID -p $MATELOT_SECRET`. Repository
paths follow `<project-slug>/<service-slug>[/<name>]:<tag>`; a project token may only push under
its project. Every push is recorded (tag, digest) on the service and an image SBOM is generated.

## External registries (Docker Hub, GHCR, GitLab, Harbor…)
Connect the registry once (*Integrations → Connect a source → Container registry*: host, robot/read
token). The pipeline pushes there as usual and reports what it deployed:

```yaml
- run: matelot deploy --env $MATELOT_ENV_DEV --image docker.io/acme/app@sha256:<digest from the push>
- run: matelot deploy --env $MATELOT_ENV_PRODUCTION --version v1.7.0 --image docker.io/acme/app:v1.7.0
```
The first report registers the image on the service; tags and digests are read through the
connection every 15 minutes; tags link to releases by version or commit; every reported tag and every
tag that appears after the first sync gets an image SBOM automatically (the historical backlog is
scanned on demand). `promote` exists only for the built-in registry — external registries have no
environment repositories, so the deploy step reports instead. Protected environments apply to
`matelot deploy` through the token's *May deploy to*.

## AWS ECR and Azure Container Registry
Connect them like any registry (*Integrations → Connect a source → AWS Elastic Container Registry /
Azure Container Registry*), but with an **IAM access key** (ECR) or a **service principal** (ACR)
instead of a Docker password. The platform exchanges those for short-lived Docker credentials —
12-hour ECR tokens via `GetAuthorizationToken` (SigV4), ~3-hour ACR refresh tokens via the AAD →
`/oauth2/exchange` flow — for tag sync, image scanning by runners, and CI logins. The AWS/Azure
secret never leaves the cell.

In CI, no cloud CLI or cloud credential is needed on the runner:

```yaml
- run: matelot registry login --connection "ECR · production" --service $MATELOT_SERVICE_ID
- run: |
    IMAGE=$(matelot registry path --service $MATELOT_SERVICE_ID --connection "ECR · production" --repository app --create)
    docker build -t $IMAGE:$GITHUB_SHA . && docker push $IMAGE:$GITHUB_SHA
- run: matelot deploy --env $MATELOT_ENV_DEV --image <image>@sha256:…
```
`registry path --connection … --repository …` resolves the host from the connection (nothing to
configure in CI); `--create` makes the ECR repository if it does not exist (token needs `registry:push`).
`matelot registry connections --service <id>` lists the connections on the service's path. Issuing
credentials requires `registry:pull` (CI presets *registry* / *pipeline* / *full*; people with deploy
rights) and is recorded in the audit trail. Minimal cloud rights: ECR — `ecr:GetAuthorizationToken`,
`ecr:BatchGetImage`, `ecr:GetDownloadUrlForLayer`, `ecr:ListImages`, `ecr:DescribeImages`
`ecr:DescribeRepositories` (+ `ecr:CreateRepository` to create repositories from the platform: connection → *Manage → ECR repositories*; + `ecr:PutImage`/`InitiateLayerUpload`/`UploadLayerPart`/`CompleteLayerUpload` for pushes);
ACR — role `AcrPull` (+ `AcrPush`).


## Installing the CLI in CI

The CLI reads `MATELOT_URL`, `MATELOT_KEY_ID`, `MATELOT_SECRET` (CI token) or `MATELOT_TOKEN` (personal token), and
`MATELOT_COMMIT` for `deploy`. The old `SECOPS_*` names are still accepted as a fallback.

Runners without access to github.com (air-gapped CI): download `matelot-cli-<version>.tgz` from the release once,
host it on an internal artifact store or npm registry (Verdaccio, Artifactory, GitHub Packages) and `npm install -g`
from there. The GitLab CI and Bitbucket Pipelines examples (`examples/`) install from the release URL.

The GitHub Action is a thin wrapper around the install; replace its `uses:` step with a `run: npm install -g …` line plus
the three environment variables when the action is not reachable.


## Gate timing in CI: wait for correlation

Right after `docker push`, the image's SBOM is still being correlated for a few seconds. `matelot gate` and
`matelot deploy` therefore wait for it (`--wait-correlation N` seconds; default **300 in CI** — detected by the `CI`
variable or a CI token — and 0 for a person at a terminal) and only then evaluate the policies.

The CLI asks the server in short slices (≤ 25 s per request, so no ingress or load balancer timeout is hit) until the
budget is spent: "waiting for SBOM correlation… (50 s / 300 s)" lines go to stderr. It also waits for the image's SBOM
to **exist**: right after a push the SBOM job may not have run, and an image nobody scanned never passes a gate, even
where the policies do not require an SBOM.

Exit codes: `0` pass/warn · `2` a blocking policy failed · `3` not evaluated (no SBOM for the image after the budget,
or its correlation still pending or failed; no counts are printed, nothing was judged) · `4` authentication.
Let a `3` fail the job loudly (the platform could not tell), but do not treat it as a security verdict.

**Breaking change in CLI 2.9.0:** an authentication failure now exits `4` (it was `3`); `3` means "not evaluated".
Scripts that tested for `3` to detect a bad token must test for `4`.


## Pipeline jobs

| Stage | Job | Tool | Needs |
|---|---|---|---|
| source | checkout | git | repository access (connection) |
| inventory | sbom | syft | — |
| scan | dependencies (`sca`) | platform correlation (OSV / NVD / KEV / EPSS) | the sbom job |
| scan | code (`sast`) | Semgrep (`--config auto`; set `SEMGREP_CONFIG=p/ci` on an offline runner) | runner image ≥ this release |
| scan | secrets, infrastructure | trivy | — |
| policy | evaluate (`policy_eval`) | platform worker | — |

Rebuild the runner image after this release (`docker build apps/runner`) so `semgrep` is present; a runner without it reports the code job as skipped with that reason.
