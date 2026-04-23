# Claude Wrapped sidecar — proxied-mode HTTP server for Floom.
FROM node:20-slim
WORKDIR /app
COPY server.mjs /app/server.mjs
ENV PORT=4111
EXPOSE 4111
# Drop root. node:20-slim ships a "node" user (uid 1000) by default.
USER node
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:4111/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
CMD ["node", "/app/server.mjs"]
