FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/workeros-cloud

# Copy repo (.dockerignore keeps .env files, node_modules, tests, and other
# non-runtime content out of the image — workeros#936).
COPY . .

# Initialize the engine/ submodule when a GIT_TOKEN build arg is provided
# (GitHub-clone deploys, which don't recurse into submodules). On `railway up`
# GIT_TOKEN is unset and engine/ is shipped via the COPY above, so this step
# is a no-op.
#
# NOTE: Railway's builder does NOT support `--mount=type=secret` (only
# `--mount=type=cache`); using it fails build validation immediately. So the
# token is read from the ARG only. Keep GIT_TOKEN out of the image by leaving
# it unset on Railway (engine/ comes from COPY).
ARG GIT_TOKEN
RUN TOKEN="$(printf '%s' "$GIT_TOKEN")"; \
    if [ -n "$TOKEN" ]; then \
      git config --global url."https://${TOKEN}@github.com/".insteadOf "https://github.com/" && \
      git submodule update --init --recursive; \
      status=$?; \
      git config --global --unset-all url."https://${TOKEN}@github.com/".insteadOf || true; \
      [ "$status" -eq 0 ] || exit "$status"; \
    fi

RUN pip install --no-cache-dir uv
RUN uv pip install --system --no-cache -r requirements.txt

# Create var dirs — volume will be mounted here at runtime
RUN mkdir -p /opt/workeros-cloud/var/workers \
             /opt/workeros-cloud/var/contexts \
             /opt/workeros-cloud/var/artifacts

# workeros#936: run the API as an unprivileged user, not root.
RUN useradd --create-home --uid 10001 workeros \
    && chown -R workeros:workeros /opt/workeros-cloud
USER workeros

EXPOSE 8000

CMD ["sh", "-c", "exec uvicorn apps.api.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
