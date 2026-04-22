#!/usr/bin/env bash
# floom-validate.sh — validate a floom.yaml before publish.
#
# Checks:
#   1. File parses as YAML.
#   2. Required fields present: name, slug, description.
#   3. Slug matches ^[a-z0-9][a-z0-9-]{0,47}$.
#   4. Either openapi_spec_url OR (runtime + actions) is present.
#
# Exit 0 on success, 1 on any validation failure. First error wins and is
# printed to stderr with the exact field name.

set -euo pipefail

FILE="${1:-floom.yaml}"
if [[ ! -f "$FILE" ]]; then
  echo "floom-validate: $FILE not found" >&2
  exit 1
fi

python3 - "$FILE" <<'PY'
import sys, re

try:
    import yaml
except ImportError:
    print("floom-validate: PyYAML not installed. pip install pyyaml", file=sys.stderr)
    sys.exit(1)

path = sys.argv[1]
try:
    with open(path) as f:
        m = yaml.safe_load(f)
except yaml.YAMLError as e:
    print(f"floom-validate: YAML parse error: {e}", file=sys.stderr)
    sys.exit(1)

if not isinstance(m, dict):
    print("floom-validate: top level must be a mapping", file=sys.stderr)
    sys.exit(1)

for field in ("name", "slug", "description"):
    v = m.get(field)
    if not v or not isinstance(v, str) or not v.strip():
        print(f"floom-validate: missing or empty required field: {field}", file=sys.stderr)
        sys.exit(1)

slug = m["slug"]
if not re.match(r"^[a-z0-9][a-z0-9-]{0,47}$", slug):
    print(
        "floom-validate: slug must match ^[a-z0-9][a-z0-9-]{0,47}$ "
        f"(got '{slug}')",
        file=sys.stderr,
    )
    sys.exit(1)

has_openapi = bool(m.get("openapi_spec_url"))
has_runtime = bool(m.get("runtime")) and bool(m.get("actions"))
if not has_openapi and not has_runtime:
    print(
        "floom-validate: manifest must declare either openapi_spec_url "
        "(proxied app) or runtime + actions (custom-code app)",
        file=sys.stderr,
    )
    sys.exit(1)

if has_openapi:
    url = m["openapi_spec_url"]
    if not (url.startswith("http://") or url.startswith("https://")):
        print(
            f"floom-validate: openapi_spec_url must be http(s) (got '{url}')",
            file=sys.stderr,
        )
        sys.exit(1)

if has_runtime:
    runtime = m["runtime"]
    if runtime not in ("python", "node"):
        print(
            f"floom-validate: runtime must be 'python' or 'node' (got '{runtime}')",
            file=sys.stderr,
        )
        sys.exit(1)
    actions = m["actions"]
    if not isinstance(actions, dict) or not actions:
        print("floom-validate: actions must be a non-empty mapping", file=sys.stderr)
        sys.exit(1)

print("ok")
PY
