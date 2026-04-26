#!/usr/bin/env bash
# floom-validate.sh — validate a floom.yaml before publish.
#
# Checks:
#   1. File parses as YAML.
#   2. Required fields present: name, slug, description.
#   3. Slug matches ^[a-z0-9][a-z0-9-]{0,47}$.
#   4. Either openapi_spec_url OR (runtime + actions) is present.
#   5. network.allowed_domains is valid when present.
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

retention = m.get("max_run_retention_days")
if retention is not None:
    if not isinstance(retention, int) or isinstance(retention, bool):
        print(
            "floom-validate: max_run_retention_days must be a positive integer",
            file=sys.stderr,
        )
        sys.exit(1)
    if retention < 1 or retention > 3650:
        print(
            "floom-validate: max_run_retention_days must be between 1 and 3650",
            file=sys.stderr,
        )
        sys.exit(1)

def valid_domain(host):
    if not isinstance(host, str) or not host or len(host) > 253 or ".." in host:
        return False
    labels = host.split(".")
    if len(labels) < 2:
        return False
    return all(
        0 < len(label) <= 63
        and not label.startswith("-")
        and not label.endswith("-")
        and re.match(r"^[a-z0-9-]+$", label)
        for label in labels
    )

network = m.get("network", {"allowed_domains": []})
if network is None or not isinstance(network, dict):
    print("floom-validate: network must be a mapping", file=sys.stderr)
    sys.exit(1)
allowed = network.get("allowed_domains", [])
if not isinstance(allowed, list) or any(not isinstance(d, str) for d in allowed):
    print("floom-validate: network.allowed_domains must be a list of strings", file=sys.stderr)
    sys.exit(1)
if len(allowed) > 20:
    print("floom-validate: network.allowed_domains can contain at most 20 domains", file=sys.stderr)
    sys.exit(1)
for i, raw_domain in enumerate(allowed):
    domain = raw_domain.strip().lower().rstrip(".")
    if domain == "*":
        print(f"floom-validate: network.allowed_domains[{i}] cannot be '*'", file=sys.stderr)
        sys.exit(1)
    if "/" in domain or "@" in domain or ":" in domain or re.match(r"^(\d{1,3}\.){3}\d{1,3}$", domain) or domain == "::1":
        print(
            f"floom-validate: network.allowed_domains[{i}] must be a domain or '*.domain' glob",
            file=sys.stderr,
        )
        sys.exit(1)
    if domain.startswith("*."):
        if not valid_domain(domain[2:]):
            print(f"floom-validate: invalid wildcard domain: {raw_domain}", file=sys.stderr)
            sys.exit(1)
    elif "*" in domain:
        print(
            f"floom-validate: network.allowed_domains[{i}] wildcard must use '*.domain'",
            file=sys.stderr,
        )
        sys.exit(1)
    elif not valid_domain(domain):
        print(f"floom-validate: invalid domain: {raw_domain}", file=sys.stderr)
        sys.exit(1)

if "auth_required" in m and "link_share_requires_auth" in m:
    print(
        "floom-validate: auth_required is deprecated; use link_share_requires_auth, not both fields",
        file=sys.stderr,
    )
    sys.exit(1)

if "auth_required" in m:
    print(
        "floom-validate: warning: auth_required is deprecated; use link_share_requires_auth",
        file=sys.stderr,
    )

print("ok")
PY
