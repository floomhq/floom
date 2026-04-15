# Hook Stats sidecar — proxied-mode HTTP server for Floom.
# Build with: docker build -t floom-example-hook-stats -f examples/hook-stats/Dockerfile examples/hook-stats
FROM node:20-slim
WORKDIR /app
COPY server.mjs /app/server.mjs
ENV PORT=4110
EXPOSE 4110
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:4110/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
CMD ["node", "/app/server.mjs"]
