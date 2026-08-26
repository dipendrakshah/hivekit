# Hivekit — single-process image, multi-arch (amd64 + arm64 for Graviton).

FROM node:22-bookworm-slim AS build
WORKDIR /app
# No glob on the lockfile: a missing pnpm-lock.yaml must fail right here,
# loudly — not surface later as a confusing --frozen-lockfile error.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Runtime dependencies only. Dev toolchain (typescript, test runners) never
# ships in the final image.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile --prod

FROM node:22-bookworm-slim
WORKDIR /app

# git + openssh-client: the `site` connector.
# ca-certificates: every outbound call.  sqlite3: backups and `hivekit doctor`.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git openssh-client ca-certificates sqlite3 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    HIVEKIT_CONFIG=/config/hivekit.yaml \
    HIVEKIT_DATA=/data

COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/examples ./examples

RUN useradd -r -u 10001 hivekit && mkdir -p /data && chown -R hivekit /data
USER hivekit

VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/main.js"]
