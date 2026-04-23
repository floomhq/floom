# Blast Radius sidecar — proxied-mode HTTP server for Floom.
# Requires `git` at runtime (apt-get install).
FROM node:20-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY server.mjs /app/server.mjs
ENV PORT=4113
EXPOSE 4113
# Drop root. node:20-slim ships a "node" user (uid 1000) by default.
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:4113/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
CMD ["node", "/app/server.mjs"]
