# Lead Scorer — Floom demo app
# Scores CSV leads against an ICP using Gemini 3 + native web search + URL context.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

# Install deps first for better layer caching.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY main.py /app/main.py

# The Floom Docker runner spawns the container with argv[1] = JSON config and
# expects the last stdout line prefixed with __FLOOM_RESULT__. See
# apps/server/src/lib/entrypoint.py.
ENTRYPOINT ["python", "/app/main.py"]
