# Matelot on Docker Compose

One cell on one host: the quick start for evaluation and small teams (Kubernetes/Helm is the production path).
This folder is published as `docker/` in https://github.com/matelot-cloud/matelot on every release; the full guide is
https://matelot.cloud/docs/latest/install.html#option-a-docker-compose.

```bash
git clone --depth 1 https://github.com/matelot-cloud/matelot && cd matelot/docker
cp .env.example .env            # MATELOT_DOMAIN (localhost to try it), MATELOT_ADMIN_EMAIL
docker compose up -d            # pulls ghcr.io/matelot-cloud/{api,web,worker,runner} (public, no login)
docker compose logs -f welcome  # URL + administrator login once the cell answers
```

| File | What |
| --- | --- |
| `compose.yaml` | the stack: `init` (first-start generation, the only root container), postgres, redis, keycloak, api, worker, web, runner, registry, caddy (the one published port pair), `welcome`, and the `backup` profile |
| `.env.example` | every setting; nothing secret — secrets are generated on first start into the `config` volume |
| `init/compose-init.sh` | generates secrets once (same layout as the Kubernetes Secrets), rewrites the derived configuration (Caddyfile, Keycloak realm, registry config, web config.json) on every start; `show`, `restore-secrets`, `realm-update` modes |
| `init/realm-sync.js` | run by the `realm-sync` service on every `up` (after Keycloak is healthy): applies the rendered realm's redirect URIs / `sslRequired` through the admin API, because `--import-realm` imports only once; a copy of the chart's `files/realm-sync.js` |
| `postgres/` | creates the keycloak database on the first start |
| `backup/` | the backup job script and the in-database restore script (copies of the Helm chart's) |
| `scripts/` (published repo only) | `cell-backup.sh --compose`, `cell-restore.sh --compose` and their lib |
| `smoke.sh` | end-to-end check: up → doctor → project → backup → `down -v` → `up -d` (new secrets) → restore → the original login works (what CI runs on every commit). Runs from its own `.env.smoke` (`COMPOSE_ENV_FILES`), never touches your `.env`; `MATELOT_CLI="node …/index.js"` to use a checkout, `--check` only resolves the CLI |

Day 2: `scripts/cell-backup.sh --compose . -d ./backups` · upgrade = `MATELOT_VERSION` in `.env` (the bare version,
`0.1.0`, not the `v0.1.0` git tag — images are published under both tags), `docker compose pull && docker compose up -d`
· `matelot doctor` · `docker compose run --rm init show` prints the admin login again.

Design notes: every service runs as a non-root user (Caddy binds 80/443 through `ip_unprivileged_port_start`);
memory limits add up to about 4 GB; the registry is `localhost:5000` on localhost (Docker treats localhost as an
insecure registry) and `registry.<domain>` over HTTPS with a real domain; Keycloak is served under `/auth` on the
same host, so a real domain needs exactly two DNS names.
