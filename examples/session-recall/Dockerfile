# Session Recall sidecar — proxied-mode HTTP server for Floom.
FROM node:20-slim
WORKDIR /app
COPY server.mjs /app/server.mjs
ENV PORT=4112
EXPOSE 4112
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node -e "fetch('http://localhost:4112/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"
CMD ["node", "/app/server.mjs"]
