# Email Signature Generator -- Floom demo app
# Deterministic formatter with optional one-call Gemini tagline mode.
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY main.py /app/main.py
COPY sample-cache.json /app/sample-cache.json

USER 1000

ENTRYPOINT ["python", "/app/main.py"]
