# Self-hosted runner: docker run -e RUNNER_URL=... -e RUNNER_REGISTRATION_TOKEN=... ghcr.io/secops-platform/runner
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json tsconfig.json ./
COPY src ./src
RUN pnpm install --no-frozen-lockfile && pnpm build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git openssh-client ca-certificates curl python3 python3-pip && rm -rf /var/lib/apt/lists/* \
    # Semgrep for the `sast` pipeline job (rules: p/ci … bundled offline; `auto` needs network)
    && pip3 install --no-cache-dir --break-system-packages semgrep==1.97.0 \
    && curl -fsSL https://raw.githubusercontent.com/anchore/syft/main/install.sh | sh -s -- -b /usr/local/bin v1.20.0 \
    && curl -fsSL https://raw.githubusercontent.com/aquasecurity/trivy/main/contrib/install.sh | sh -s -- -b /usr/local/bin v0.74.0 \
    && curl -fsSL -o /usr/local/bin/kubectl "https://dl.k8s.io/release/$(curl -fsSL https://dl.k8s.io/release/stable.txt)/bin/linux/$(dpkg --print-architecture)/kubectl" && chmod +x /usr/local/bin/kubectl \
    && groupadd --gid 10001 runner && useradd --uid 10001 --gid runner --create-home runner && mkdir -p /data && chown runner:runner /data
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
USER runner
ENV RUNNER_DATA_DIR=/data NODE_ENV=production
VOLUME ["/data"]
CMD ["node", "dist/index.js"]
