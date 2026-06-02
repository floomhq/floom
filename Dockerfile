FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/workeros-cloud

# Copy repo
COPY . .

# Initialize the engine/ submodule. Railway clones the repo from GitHub but
# does not recurse into submodules. GIT_TOKEN must be a GitHub token with
# read access to floomhq/workeros — set it as a Railway build variable.
ARG GIT_TOKEN
RUN if [ -n "$GIT_TOKEN" ]; then \
      git config --global url."https://${GIT_TOKEN}@github.com/".insteadOf "https://github.com/" && \
      git submodule update --init --recursive && \
      git config --global --unset-all url."https://${GIT_TOKEN}@github.com/".insteadOf || true; \
    fi

# openai-agents>=0.17 needs websockets>=15; supabase/realtime pins websockets<15.
# Locally websockets==16 works fine (real-time subscriptions unused).
# Force-resolve via uv override — matches the working local venv.
RUN pip install --no-cache-dir uv
RUN echo "websockets>=15.0,<17" > /tmp/ws_override.txt
RUN uv pip install --system --no-cache -r requirements.txt --override /tmp/ws_override.txt

# Create var dirs — volume will be mounted here at runtime
RUN mkdir -p /opt/workeros-cloud/var/workers \
             /opt/workeros-cloud/var/contexts \
             /opt/workeros-cloud/var/artifacts

EXPOSE 8000

CMD ["sh", "-c", "exec uvicorn apps.api.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
