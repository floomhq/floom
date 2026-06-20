# syntax=docker/dockerfile:1
FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/workeros-cloud

RUN pip install --no-cache-dir uv

# --- Dependency layer (cached) -------------------------------------------------
# Install Python deps in a layer keyed ONLY on the requirements files, copied
# BEFORE the app code. A code-only deploy then reuses this cached layer instead
# of reinstalling ~80 packages every time, cutting build time from ~3min to
# ~30-45s. The cloud requirements.txt chains: root -> apps/api/requirements.txt
# -> engine/apps/api/requirements.txt, so all three are copied first. On `railway
# up` the engine/ submodule files are present in the build context.
COPY requirements.txt ./requirements.txt
COPY apps/api/requirements.txt ./apps/api/requirements.txt
COPY engine/apps/api/requirements.txt ./engine/apps/api/requirements.txt
# Persistent BuildKit cache for uv's wheel downloads: even when requirements
# change (e.g. an engine bump), wheels are reused from cache instead of being
# re-downloaded from PyPI — the bulk of the old ~3min build. (Was --no-cache,
# which actively defeated this.)
RUN --mount=type=cache,target=/root/.cache/uv \
    uv pip install --system -r requirements.txt

# --- App code ------------------------------------------------------------------
# (.dockerignore keeps .env files, node_modules, tests, and other non-runtime
# content out of the image — workeros#936.)
COPY . .

# Initialize the engine/ submodule when a GIT_TOKEN build arg is provided
# (GitHub-clone deploys, which don't recurse into submodules). On `railway up`
# GIT_TOKEN is unset and engine/ is shipped via the COPY above, so this step is a
# no-op. The re-install covers a clone build where engine/ was absent during the
# dependency layer above; on `railway up` every dep is already satisfied so it is
# a fast no-op.
ARG GIT_TOKEN
RUN --mount=type=cache,target=/root/.cache/uv \
    TOKEN="$(printf '%s' "$GIT_TOKEN")"; \
    if [ -n "$TOKEN" ]; then \
      git config --global url."https://${TOKEN}@github.com/".insteadOf "https://github.com/" && \
      git submodule update --init --recursive && \
      uv pip install --system -r requirements.txt; \
      status=$?; \
      git config --global --unset-all url."https://${TOKEN}@github.com/".insteadOf || true; \
      [ "$status" -eq 0 ] || exit "$status"; \
    fi

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
