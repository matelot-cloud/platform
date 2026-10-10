# syntax=docker/dockerfile:1.7
# Build from the repository root:  docker build -f apps/web/Dockerfile -t secops-web:dev .

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --filter @secops/web
COPY apps/web apps/web
COPY docs docs
COPY tools/docs-site tools/docs-site
RUN pnpm --filter @secops/web build

FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
