# clausroom server image.
# Build from the REPO ROOT (the compose file does this for you):
#   docker build -f deploy/Dockerfile -t clausroom-server .
#
# The container runs ONLY the server (apps/server) and serves the built web UI.
# Bridges run on each human's machine, never in this container.

# ---------- build stage ----------
FROM node:22-bookworm-slim AS build

# Toolchain for better-sqlite3's native module.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install with the workspace layout in place (manifests first for layer caching).
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/bridge/package.json apps/bridge/
COPY apps/web/package.json apps/web/
RUN npm ci

# Build all workspaces (protocol -> server -> bridge -> web).
COPY packages ./packages
COPY apps ./apps
RUN npm run build

# Drop dev dependencies for the runtime copy.
RUN npm prune --omit=dev

# ---------- runtime stage ----------
FROM node:22-bookworm-slim

# curl for the healthcheck; non-root user; /data volume for DB + artifacts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home clausroom \
 && mkdir -p /data \
 && chown clausroom:clausroom /data

ENV NODE_ENV=production \
    # 0.0.0.0 INSIDE the container only; compose publishes it on 127.0.0.1.
    AGENT_ROOM_HOST=0.0.0.0 \
    AGENT_ROOM_PORT=3000 \
    AGENT_ROOM_DB=/data/clausroom.sqlite \
    AGENT_ROOM_ARTIFACT_DIR=/data/artifacts \
    AGENT_ROOM_WEB_DIST=/app/apps/web/dist

WORKDIR /app

# Production node_modules (workspace symlinks resolve against the dirs below).
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist

USER clausroom
VOLUME /data
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/healthz || exit 1

CMD ["node", "apps/server/dist/index.js"]
