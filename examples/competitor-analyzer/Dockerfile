# Competitor Analyzer — CLI-per-request Python app for Floom.
# Reads one JSON blob from argv[1] (or stdin) and emits one JSON blob on stdout.
FROM python:3.12-slim

WORKDIR /app

# Zero third-party deps (see requirements.txt), so pip install is a no-op.
# We still COPY + pip install to keep the Dockerfile honest for future deps.
COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY main.py /app/main.py

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# Drop root. python:3.12-slim has no non-root user by default, so use a numeric
# UID the runtime can chown or bind-mount against without a /etc/passwd entry.
USER 1000

ENTRYPOINT ["python", "/app/main.py"]
