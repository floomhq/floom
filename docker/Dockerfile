# Floom — multi-stage production Docker image.
# Stage 1 (builder): install all deps + build TypeScript + Vite.
# Stage 2 (runtime): copy only production deps + compiled artifacts.
#
# Build with: docker build -t floom-chat:latest -f docker/Dockerfile .
# The build context must be the repo root.

# ── stage 1: builder ────────────────────────────────────────────────────────
FROM node:20-slim AS builder
WORKDIR /app

RUN npm install -g pnpm@9.0.0

# Copy package manifests first (for layer caching).
# packages/detect, /manifest, /runtime, /cli were removed in PR #29
# (chore: drop runtime-deploy path, ship OpenAPI-only). Only
# @floom/renderer remains in the workspace.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/renderer/package.json ./packages/renderer/
COPY turbo.json tsconfig.base.json ./

# Install ALL deps (devDependencies needed for build)
RUN pnpm install --frozen-lockfile

# Copy all source
COPY apps ./apps
COPY packages ./packages
# Root AGENTS.md is read by apps/web/scripts/sync-agents-md.mjs at prebuild
# time to copy itself into apps/web/public/ so Vite ships it in dist/.
# Without this COPY the web build fails because the prebuild step can't
# find the canonical source. See P0-4 (launch audit 2026-04-24).
COPY AGENTS.md ./AGENTS.md
# The same prebuild step also syncs the canonical CLI installer into
# apps/web/public/install.sh. Keep the source path in the builder context so
# preview/prod Docker builds match local repo builds.
COPY cli/floom/install.sh ./cli/floom/install.sh
# Copy the fast-apps sidecar bundle into the build context so the runtime
# stage can grab it from the builder image. Pure .mjs source, no build step.
COPY examples/fast-apps ./examples/fast-apps
# Launch demos (#252): the 3 showcase apps shipped as self-contained
# python:3.12-slim images. services/launch-demos.ts reads each demo's
# Dockerfile + source from these dirs on boot and builds the image against
# the host docker daemon (via the mounted /var/run/docker.sock).
COPY examples/lead-scorer ./examples/lead-scorer
COPY examples/competitor-analyzer ./examples/competitor-analyzer
COPY examples/resume-screener ./examples/resume-screener

# Re-run pnpm install to re-link workspace packages after the source COPY.
# pnpm 9 has a symlink quirk where workspace package symlinks created by the
# first install (line ~26) don't resolve correctly to the workspace source
# once that source is layered in via COPY. Without this, `vite build` silently
# fails to resolve '@floom/renderer' etc and hits the fallback stub below.
RUN pnpm install --frozen-lockfile

# Sentry build-time args. All optional:
#   - VITE_SENTRY_DSN is baked into the web bundle so the browser knows where
#     to POST errors. Unset = Sentry stays dark on the client.
#   - SENTRY_AUTH_TOKEN/ORG/PROJECT wire @sentry/vite-plugin to upload source
#     maps during the Vite build, then delete .map files from dist/ so the
#     runtime image doesn't ship them. All three unset = plugin no-ops and
#     maps are generated but not uploaded.
# Pass at build time: docker build --build-arg VITE_SENTRY_DSN=... ...
ARG VITE_SENTRY_DSN
ARG SENTRY_AUTH_TOKEN
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
ENV SENTRY_AUTH_TOKEN=${SENTRY_AUTH_TOKEN}
ENV SENTRY_ORG=${SENTRY_ORG}
ENV SENTRY_PROJECT=${SENTRY_PROJECT}

# Build server (TypeScript → dist/)
RUN cd apps/server && pnpm run build

# Build web (Vite → dist/) — fail LOUDLY if the build breaks so we never
# silently ship the backend-only stub again.
RUN cd apps/web && pnpm run build

# ── stage 2: runtime ────────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app

# System deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV DATA_DIR=/data
ENV PORT=3051
# PORT can be overridden at runtime (e.g. docker run -e PORT=3000 ...)

RUN npm install -g pnpm@9.0.0

# Copy package manifests (see PR #29 note in the builder stage).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/renderer/package.json ./packages/renderer/

# Install only production server dependencies.
# @floom/renderer is a workspace:* dep but the server only needs its *types*
# at runtime (erased at compile time) + esbuild reads the source directly for
# the bundler service. pnpm will symlink the workspace package — the source
# is copied below from the builder stage.
RUN pnpm install --filter @floom/server --prod

# Rebuild better-sqlite3 native module against the container's Node ABI
RUN cd apps/server && pnpm rebuild better-sqlite3 2>&1 | tail -5 || true

# Copy compiled artifacts from builder
COPY --from=builder /app/apps/server/dist ./apps/server/dist
COPY --from=builder /app/apps/web/dist ./apps/web/dist

# Copy @floom/renderer source — esbuild needs it at runtime for the renderer
# bundler service (creator custom renderers are bundled on ingest).
COPY --from=builder /app/packages/renderer/src ./packages/renderer/src

# Copy the fast-apps sidecar bundle. Pure Node.js, no deps, forked as a
# child process at server boot to register seven deterministic utility apps
# (uuid, password, hash, base64, json-format, jwt-decode, word-count).
# Set FLOOM_FAST_APPS=false to skip this on environments that prefer an
# empty hub.
COPY --from=builder /app/examples/fast-apps ./examples/fast-apps

# Launch demos (#252): source dirs consumed at boot by
# services/launch-demos.ts to build + register the 3 showcase apps
# (lead-scorer, competitor-analyzer, resume-screener).
# Set FLOOM_SEED_LAUNCH_DEMOS=false to skip.
COPY --from=builder /app/examples/lead-scorer ./examples/lead-scorer
COPY --from=builder /app/examples/competitor-analyzer ./examples/competitor-analyzer
COPY --from=builder /app/examples/resume-screener ./examples/resume-screener

WORKDIR /app/apps/server

VOLUME ["/data"]

EXPOSE 3051
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/api/health || exit 1

CMD ["node", "dist/index.js"]
