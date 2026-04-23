# Resume Screener -- Floom demo app.
# Standalone image. For Floom's managed build path the floom runtime generates
# its own Dockerfile via apps/server/src/services/docker.ts (buildPythonDockerfile).
# This file lets you run the app directly with `docker run`.
FROM python:3.12-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY main.py /app/main.py
# sample-cache.json is the baked-in golden for the /p/resume-screener demo
# input. Bundled into the image so cache hits work offline.
COPY sample-cache.json /app/sample-cache.json

ENV PYTHONUNBUFFERED=1
ENV PYTHONDONTWRITEBYTECODE=1

# Drop root. python:3.12-slim has no non-root user by default, so use a numeric
# UID the runtime can chown or bind-mount against without a /etc/passwd entry.
USER 1000

ENTRYPOINT ["python", "/app/main.py"]
