# Make it work — platform, runner, CLI, test-repo

Everything below runs in **WSL**. Paths: platform `~/repos/secops-platform`, CLI repo
`/mnt/d/work-drive/dataverse-engineering-technology-PFA/repos/matelot-cli`, test repo on Windows.

## 1. Platform (API, web, worker)
```bash
cd ~/repos
unzip -o <download-path>/secops-platform-final.zip -d /tmp/sp-final
rsync -a --exclude .env /tmp/sp-final/secops-platform/ ~/repos/secops-platform/     # keeps your .env
cd ~/repos/secops-platform
pnpm install
make dev-infra            # postgres, redis, keycloak, registry (if not running)
make migrate              # applies up to 0020 (risk, code findings, personal tokens)
```
Start (each in its own terminal): `make dev` (API :3000) · `make worker` · `make web` (UI :5173).
`.env` must contain `REGISTRY_*` and, to show the local image name in snippets, `RUNNER_IMAGE=secops-runner:local`.

## 2. Runner (Docker, with Syft + Trivy)
```bash
make runner-image
docker rm -f secops-runner
docker run -d --name secops-runner --restart unless-stopped \
  -e RUNNER_URL=http://host.docker.internal:3000/api/v1 -e RUNNER_NAME=docker-runner \
  -v secops-runner:/data secops-runner:local
docker logs secops-runner --tail 3        # "resuming runner …" (or "registered as …")
```
New runner or wiped volume: add `-e RUNNER_REGISTRATION_TOKEN=<token from Runners → Register runner>`.
Runners page → **v0.2.0**, online.

## 3. CLI 1.6.0 (personal tokens, deploy --commit)
Quickest — from the platform repo you just updated:
```bash
cd ~/repos/secops-platform/apps/cli && pnpm build && npm install -g . && hash -r
matelot --version          # 1.6.0
```
Or from the package: `npm install -g <path>/matelot-cli-1.6.0.tgz`.
Keep the CLI repo in sync (GitHub/npm): copy `src/`, `package.json`, `README.md` from
`matelot-cli-repo.zip`, then `git commit -am "1.6.0" && git tag v1.6.0 && git push && git push origin v1.6.0`.

## 4. Tokens
* **Personal** (you, scripts, API): user menu → *Access tokens* → New token (`read` / `write` / `sudo` for admins).
  ```bash
  export SECOPS_URL=http://localhost:3000 SECOPS_TOKEN=spt_…
  matelot whoami
  node ~/repos/secops-platform/tools/api/secops-api-check.mjs      # every GET endpoint → PASS/DENIED/FAIL
  ```
* **CI** (pipelines): project → Settings → CI tokens — *build* (may deploy to `test`) and *release* (may deploy to `prod`).

## 5. test-repo (GitHub Actions)
Unzip `test-repo-ci.zip` into the repo (workflows, `registry.sh`, `Dockerfile.dev/test/prod`, `.dockerignore`,
`TESTING.md`), delete the old per-registry workflows, commit, push.
Variables / secrets: see `TESTING.md` (SECOPS_URL, SECOPS_SERVICE_ID, SECOPS_ENV_DEV/TEST/PRODUCTION,
SECOPS_ECR_CONNECTION, SECOPS_ACR_CONNECTION, DOCKERHUB_REPO, SECOPS_REGISTRY_DEV/TEST/PROD ·
SECOPS_KEY_ID/SECRET, SECOPS_RELEASE_KEY_ID/SECRET, DOCKERHUB_USERNAME/TOKEN).

## 6. Run the flow
```powershell
git commit --allow-empty -m "dev build"; git push           # dev
git tag v1.9.3-rc1; git push origin v1.9.3-rc1               # test
git tag v1.9.3;     git push origin v1.9.3                   # prod
```
Check: Releases & images (1.9.3 → prod chip) · Security graph (hover 1.9.3) · Vulnerabilities → Running in
(dev/test/prod differ) · Code tab (secret + Dockerfile findings) · Risk · Audit (`release.created`).

## Troubleshooting
| Symptom | Fix |
|---|---|
| `matelot --version` shows 0.1.0 | an old copy first in PATH: `which -a secops`, `npm uninstall -g matelot-cli`, reinstall |
| `Missing SECOPS_KEY_ID…` with a personal token | CLI older than 1.6.0, or `SECOPS_TOKEN` not exported in this shell |
| pipeline `secrets`/`infrastructure` skipped or failed | runner not rebuilt: step 2 |
| `ECONNREFUSED 127.0.0.1:3000` in the web app | `make dev` not running |
| release not linked to prod | CLI < 1.6.0 on the GitHub runner, or old workflows without the commit |


## Built-in registry from WSL tools (crane, skopeo, docker CLI on WSL)

`deploy/registry/config-dev.yml` points the registry's token realm at `http://host.docker.internal:3000/api/v1/registry/token`:
the registry container reaches the API that way. Clients on the WSL host that follow the realm (crane, skopeo) resolve
`host.docker.internal` to the Windows IP and time out. Two options:

1. Make the name resolve to the API from WSL: in `/etc/wsl.conf` set `[network] generateHosts = false`, add
   `127.0.0.1 host.docker.internal` to `/etc/hosts`, then `wsl --shutdown` from Windows.
2. Or set the realm to a name both sides reach (e.g. the WSL IP from `hostname -I`, or a tunnel host) via
   `REGISTRY_AUTH_TOKEN_REALM=http://<that host>:3000/api/v1/registry/token` in the repository's root `.env` (read by docker compose) and `docker compose up -d registry`.

Docker inside Docker Desktop is unaffected: it reaches `host.docker.internal` natively.
