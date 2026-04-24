# Competitor Lens — bounded URL-vs-URL comparison demo for Floom.
# The image keeps the same layout as the other Python demos: copy
# requirements, install, then run main.py directly.
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

COPY main.py /app/main.py
COPY sample-cache.json /app/sample-cache.json

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER 1000

ENTRYPOINT ["python", "/app/main.py"]
