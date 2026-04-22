#!/usr/bin/env bash
# floom-init.sh — scaffold a floom.yaml in the current directory.
#
# Non-interactive flags:
#   --name <name>              app name (e.g. "Lead Scorer")
#   --slug <slug>              slug override (default: derived from name)
#   --description <desc>       one-sentence description
#   --openapi-url <url>        wrap an existing OpenAPI service
#   --type <proxied|custom>    app type (default: proxied if --openapi-url, else custom)
#   --secrets <A,B,C>          comma-separated secret names (custom apps only)
#
# Interactive mode: if required fields are missing and stdin is a TTY,
# prompt. Otherwise exit 1 with a clear error.

set -euo pipefail

NAME=""
SLUG=""
DESCRIPTION=""
OPENAPI_URL=""
APP_TYPE=""
SECRETS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)         NAME="$2"; shift 2 ;;
    --slug)         SLUG="$2"; shift 2 ;;
    --description)  DESCRIPTION="$2"; shift 2 ;;
    --openapi-url)  OPENAPI_URL="$2"; shift 2 ;;
    --type)         APP_TYPE="$2"; shift 2 ;;
    --secrets)      SECRETS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,14p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *)
      echo "floom init: unknown flag: $1" >&2
      exit 1 ;;
  esac
done

prompt() {
  local question="$1"
  local default="${2:-}"
  local answer
  if [[ ! -t 0 ]]; then
    echo "floom init: missing required field (not a TTY, use flags)" >&2
    exit 1
  fi
  if [[ -n "$default" ]]; then
    read -r -p "$question [$default]: " answer
    echo "${answer:-$default}"
  else
    read -r -p "$question: " answer
    echo "$answer"
  fi
}

derive_slug() {
  echo "$1" | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9]\+/-/g; s/^-\+//; s/-\+$//' \
    | cut -c1-48
}

[[ -z "$NAME" ]] && NAME=$(prompt "App name (e.g. Lead Scorer)")
[[ -z "$NAME" ]] && { echo "floom init: name is required" >&2; exit 1; }

[[ -z "$SLUG" ]] && SLUG=$(derive_slug "$NAME")
if [[ ! "$SLUG" =~ ^[a-z0-9][a-z0-9-]{0,47}$ ]]; then
  echo "floom init: derived slug '$SLUG' is invalid. Pass --slug." >&2
  exit 1
fi

[[ -z "$DESCRIPTION" ]] && DESCRIPTION=$(prompt "One-sentence description")
[[ -z "$DESCRIPTION" ]] && { echo "floom init: description is required" >&2; exit 1; }

if [[ -z "$APP_TYPE" ]]; then
  if [[ -n "$OPENAPI_URL" ]]; then
    APP_TYPE="proxied"
  else
    APP_TYPE=$(prompt "App type: (a) proxied OpenAPI, or (b) custom Python code" "a")
    case "$APP_TYPE" in
      a|A|proxied) APP_TYPE="proxied" ;;
      b|B|custom)  APP_TYPE="custom" ;;
      *) echo "floom init: unknown type '$APP_TYPE'" >&2; exit 1 ;;
    esac
  fi
fi

if [[ -f floom.yaml ]]; then
  echo "floom init: floom.yaml already exists in $(pwd). Refusing to overwrite." >&2
  exit 1
fi

case "$APP_TYPE" in
  proxied)
    [[ -z "$OPENAPI_URL" ]] && OPENAPI_URL=$(prompt "OpenAPI spec URL")
    if [[ ! "$OPENAPI_URL" =~ ^https?:// ]]; then
      echo "floom init: openapi-url must start with http(s)://" >&2
      exit 1
    fi
    cat > floom.yaml <<YAML
name: $NAME
slug: $SLUG
description: $DESCRIPTION
type: proxied
openapi_spec_url: $OPENAPI_URL
visibility: private
manifest_version: "2.0"
YAML
    ;;
  custom)
    if [[ -z "$SECRETS" ]] && [[ -t 0 ]]; then
      SECRETS=$(prompt "Secrets needed (comma-separated, optional)" "")
    fi
    SECRETS_YAML="[]"
    if [[ -n "$SECRETS" ]]; then
      SECRETS_YAML="[$(echo "$SECRETS" | sed 's/,/, /g')]"
    fi
    cat > floom.yaml <<YAML
name: $NAME
slug: $SLUG
description: $DESCRIPTION
category: custom
runtime: python
actions:
  run:
    label: Run
    description: $DESCRIPTION
    inputs:
      - {name: input, label: Input, type: textarea, required: true}
    outputs:
      - {name: result, label: Result, type: text}
python_dependencies: []
secrets_needed: $SECRETS_YAML
manifest_version: "2.0"
YAML
    if [[ ! -f main.py ]]; then
      cat > main.py <<'PY'
import json, sys

def run(input: str) -> dict:
    return {"result": f"Echo: {input}"}

if __name__ == "__main__":
    payload = json.loads(sys.stdin.read() or "{}")
    out = run(**payload.get("inputs", {}))
    print("__FLOOM_RESULT__" + json.dumps(out))
PY
    fi
    if [[ ! -f Dockerfile ]]; then
      cat > Dockerfile <<'DOCKER'
FROM python:3.11-slim
WORKDIR /app
COPY main.py .
CMD ["python", "main.py"]
DOCKER
    fi
    ;;
  *)
    echo "floom init: unknown type '$APP_TYPE'" >&2
    exit 1 ;;
esac

echo "Wrote floom.yaml (slug: $SLUG, type: $APP_TYPE)"
echo "Next: floom deploy"
