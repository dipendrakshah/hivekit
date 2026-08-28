# Hivekit — single-process image, multi-arch (amd64 + arm64 for Graviton).
# Bun end to end: native WebSocket, built-in SQLite (no FFI), ~40 ms cold start.

FROM oven/bun:1 AS build
WORKDIR /app
# No glob on the lockfile: a missing bun.lock must fail right here,
# loudly — not surface later as a confusing --frozen-lockfile error.
# All workspace manifests must exist BEFORE install, or bun resolves no
# workspaces and vite/@hivekit/* deps silently vanish (build fails loudly here).
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/memory/package.json packages/memory/package.json
COPY packages/models/package.json packages/models/package.json
COPY packages/tools/package.json packages/tools/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/routines/package.json packages/routines/package.json
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# Runtime dependencies only. Dev toolchain (typescript, test runners) never
# ships in the final image.
FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/memory/package.json packages/memory/package.json
COPY packages/models/package.json packages/models/package.json
COPY packages/tools/package.json packages/tools/package.json
COPY packages/connectors/package.json packages/connectors/package.json
COPY packages/routines/package.json packages/routines/package.json
RUN bun install --frozen-lockfile --production

FROM oven/bun:1-slim
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
  CMD bun -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "dist/main.js"]
