# syntax=docker/dockerfile:1.7
# Build from the repository root:  docker build -f apps/api/Dockerfile -t secops-api:dev .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

# ---- dependencies (full, for building) --------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile

# ---- build -------------------------------------------------------------------
FROM deps AS build
COPY apps/api apps/api
RUN pnpm --filter @secops/api build

# ---- production dependencies only -------------------------------------------
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --prod

# ---- runtime -----------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
# the build these processes report (matelot_build_info, GET /api/v1/version); CI passes the commit and the time
ARG APP_COMMIT=unknown
ARG APP_BUILT_AT=unknown
ENV NODE_ENV=production APP_COMMIT=$APP_COMMIT APP_BUILT_AT=$APP_BUILT_AT
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 app && useradd --uid 10001 --gid app --create-home --shell /usr/sbin/nologin app
WORKDIR /app
# pnpm's node_modules use relative symlinks, so the /repo layout is preserved under /app.
COPY --from=prod-deps --chown=app:app /repo/node_modules ./node_modules
COPY --from=prod-deps --chown=app:app /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=app:app /repo/apps/api/dist ./apps/api/dist
COPY --from=build --chown=app:app /repo/apps/api/drizzle ./apps/api/drizzle
COPY --from=build --chown=app:app /repo/apps/api/package.json ./apps/api/package.json
USER app
WORKDIR /app/apps/api
EXPOSE 3000 9464
# the tracing preload (dist/telemetry/tracing.js) is a no-op without an OTLP endpoint — docs/observability.md
CMD ["node", "-r", "./dist/telemetry/tracing.js", "dist/main.js"]

# ---- worker: the same runtime with the worker entrypoint (published as ghcr.io/matelot-cloud/worker) -----------------
FROM runtime AS worker
ENV MATELOT_COMPONENT=worker
CMD ["node", "-r", "./dist/telemetry/tracing.js", "dist/worker.js"]

