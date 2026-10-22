.RECIPEPREFIX := >
SHELL := /usr/bin/env bash
TENANT ?= acme
TENANT_NAME ?= ACME Corp
IMAGE ?= secops-api
IMAGE_WEB ?= secops-web
IMAGE_RUNNER ?= secops-runner
IMAGE_WORKER ?= secops-worker
TAG ?= dev

.PHONY: help install dev-infra dev dev-stop worker runner runner-image registry-keys web migrate build test token smoke kind-up kind-down kind-jaeger kind-observability image kind-load deploy provision decommission backup restore undeploy helm-lint docs-check docs-sync check-layout

help: ## List targets
> @grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  %-12s %s\n", $$1, $$2}'

install: ## Install workspace dependencies
> pnpm install

registry-keys: ## Generate the built-in registry signing key and dev settings (once)
> bash scripts/registry-keys.sh
> @grep -q '^REGISTRY_HOST=' .env 2>/dev/null || { printf 'REGISTRY_HOST=localhost:5000\nREGISTRY_TOKEN_KEY_PATH=%s/deploy/registry/certs/registry.key\nREGISTRY_EVENTS_SECRET=change-me-registry-events-secret\n' "$$(pwd)" >> .env && echo 'added REGISTRY_* settings to .env — restart make dev/worker'; }

dev-infra: registry-keys ## Start Postgres, Redis, Keycloak and the built-in registry with docker compose
> docker compose up -d
> @echo "Keycloak admin console: http://localhost:8080 (admin / admin)"

dev: ## Run the API in watch mode (needs dev-infra and a .env); compiles into apps/api/dist
> [[ "$${DEV_GUARD:-1}" == 0 ]] || bash scripts/dev-guard.sh api
> pnpm --filter @secops/api dev

dev-stop: ## Stop every API / worker watcher of this checkout (leftovers from closed terminals keep restarting on every edit)
> bash scripts/dev-stop.sh

worker: ## Run the background worker with hot reload; compiles into apps/api/dist-worker (never dist/, which the API watcher runs)
> [[ "$${DEV_GUARD:-1}" == 0 ]] || bash scripts/dev-guard.sh worker
> pnpm --filter @secops/api exec nest start --watch --entryFile worker --path tsconfig.worker.json

runner: ## Run a local runner from source (needs RUNNER_REGISTRATION_TOKEN on first start; state in .runner/)
> pnpm --filter @secops/runner build && RUNNER_URL=$${RUNNER_URL:-http://localhost:3000/api/v1} RUNNER_DATA_DIR=$$PWD/.runner RUNNER_NAME=$${RUNNER_NAME:-$$(hostname)} pnpm --filter @secops/runner start

runner-image: ## Build the runner Docker image (recreate the container afterwards; add -e REGISTRY_HOST_ALIASES=localhost:5000=host.docker.internal:5000 for the local registry) locally (tag from RUNNER_IMAGE in .env, default secops-runner:local)
> docker build -t $${RUNNER_IMAGE:-secops-runner:local} apps/runner

web: ## Run the web app (Vite) on http://localhost:5173, proxying /api to the API
> pnpm --filter @secops/web dev

migrate: ## Apply migrations (DATABASE_URL from the environment or .env)
> pnpm --filter @secops/api db:migrate

build: ## Compile the API and the web app
> pnpm -r build

test: ## Unit tests
> pnpm -r test

token: ## Print a dev access token (admin@acme.local)
> @bash scripts/token.sh

smoke: ## Smoke test the local stack
> bash scripts/smoke.sh

kind-up: ## Create the local kind cluster with ingress-nginx
> bash scripts/kind-up.sh

kind-down: ## Delete the kind cluster
> kind delete cluster --name secops

kind-jaeger: ## Jaeger all-in-one on kind and the cell exporting traces to it: make kind-jaeger TENANT=acme
> bash scripts/kind-jaeger.sh $(TENANT)

kind-observability: ## kube-prometheus-stack + Tempo + Loki + Alloy on kind and the cell wired to them: make kind-observability TENANT=acme
> bash scripts/kind-observability.sh $(TENANT)

image: ## Build the API, web and runner container images
> docker build -f apps/api/Dockerfile -t $(IMAGE):$(TAG) .
> docker build -f apps/api/Dockerfile --target worker -t $(IMAGE_WORKER):$(TAG) .
> docker build -f apps/web/Dockerfile -t $(IMAGE_WEB):$(TAG) .
> docker build -t $(IMAGE_RUNNER):$(TAG) apps/runner

kind-load: image ## Load the images into kind (API, web, managed runner)
> kind load docker-image $(IMAGE):$(TAG) --name secops
> kind load docker-image $(IMAGE_WORKER):$(TAG) --name secops
> kind load docker-image $(IMAGE_WEB):$(TAG) --name secops
> kind load docker-image $(IMAGE_RUNNER):$(TAG) --name secops

BACKUP_DIR ?= ./backups

deploy: ## Deploy (or upgrade) one tenant cell: make deploy TENANT=acme
> helm upgrade --install $(TENANT) deploy/helm/secops-cell \
>   --namespace tenant-$(TENANT) --create-namespace \
>   --set tenant.slug=$(TENANT) \
>   --set tenant.name="$(TENANT_NAME)" \
>   --set ingress.tls=true --set 'ingress.annotations.cert-manager\.io/cluster-issuer=selfsigned' \
>   --set "tenant.adminEmails={admin@$(TENANT).local}" \
>   --set "keycloak.seedUsers[0].username=admin" \
>   --set "keycloak.seedUsers[0].email=admin@$(TENANT).local" \
>   --set "keycloak.seedUsers[0].password=admin" \
>   --set image.repository=$(IMAGE) --set image.tag=$(TAG) \
>   --set worker.image.repository=$(IMAGE_WORKER) --set worker.image.tag=$(TAG) \
>   --set web.image.repository=$(IMAGE_WEB) --set web.image.tag=$(TAG) \
>   --set managedRunners.image.repository=$(IMAGE_RUNNER) --set managedRunners.image.tag=$(TAG)

provision: ## Provision or upgrade a tenant cell from deploy/cells/$(TENANT).values.yaml: make provision TENANT=globex
> bash scripts/cell-provision.sh apply --slug $(TENANT)

decommission: ## Take a tenant cell down (final backup, helm uninstall; add PURGE=1 to delete the namespace and volumes)
> bash scripts/cell-decommission.sh --slug $(TENANT) $(if $(PURGE),--purge,)

backup: ## Back up one tenant cell now and download the archive: make backup TENANT=acme [BACKUP_DIR=./backups]
> bash scripts/cell-backup.sh -r $(TENANT) -n tenant-$(TENANT) -d $(BACKUP_DIR)

restore: ## Restore a tenant cell from an archive: make restore TENANT=acme ARCHIVE=backups/acme-….tar.gz
> bash scripts/cell-restore.sh -r $(TENANT) -n tenant-$(TENANT) $(ARCHIVE)

undeploy: ## Remove a tenant cell (keeps the PVC unless you delete the namespace)
> helm uninstall $(TENANT) --namespace tenant-$(TENANT)

WEBSITE_DIR ?= ../website

docs-check: ## Render docs/ to a temp dir and check every link (what CI runs)
> node tools/docs-site/test.mjs && node tools/docs-site/build.mjs --check

docs-sync: ## Render docs/ into a local clone of matelot-cloud/website (WEBSITE_DIR=../website) as docs/latest, then build the site there to preview it
> node tools/docs-site/build.mjs --out $(WEBSITE_DIR)/docs/latest --version latest
> cd $(WEBSITE_DIR) && node tools/build.mjs && echo "preview: npx serve $(WEBSITE_DIR)/dist"

check-layout: ## Fail on stale top-level directories left by old drops and on retired names (what CI runs)
> bash scripts/check-layout.sh && bash scripts/check-forbidden.sh && bash scripts/check-workflows.sh

helm-lint: ## Lint and render the chart in every supported configuration (defaults, production, backups, S3, external DB, TLS)
> bash scripts/chart-test.sh
