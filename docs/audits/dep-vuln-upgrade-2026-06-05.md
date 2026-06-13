# API Dependency Vulnerability Upgrade Audit - 2026-06-05

Branch: `fix/dep-vulns-20260605`
Scope: `apps/api/requirements.txt`
Tooling: `pip-audit 2.10.0`, Python 3.12.3 venv at `apps/api/venv`

## Summary

the operator's external audit reported 64 vulnerabilities across 18 packages. The
branch manifest scan performed for this change resolved 9 vulnerabilities across
3 packages before the upgrade. After the pinned upgrades, `pip-audit` reported
0 known vulnerabilities for `apps/api/requirements.txt`.

Authlib was not present in the resolved `apps/api` dependency graph and no
first-party Python code under `apps/api` imports Authlib, PyJWT, Cryptography, or
lxml. PyJWT, Cryptography, and lxml were still pinned explicitly to audited safe
versions to prevent future resolver drift.

## Baseline Scan

Command:

```bash
python3 -m pip_audit -r apps/api/requirements.txt --format json --progress-spinner off
```

Result: 9 known vulnerabilities in 3 packages.

| Package | Resolved version before | Advisory | Fixed in |
|---|---:|---|---|
| `python-dotenv` | `1.0.1` | `CVE-2026-28684` / `GHSA-mf9w-mj56-hr94` | `1.2.2` |
| `python-multipart` | `0.0.9` | `CVE-2024-53981` / `GHSA-59g5-xgcq-4qw3` | `0.0.18` |
| `python-multipart` | `0.0.9` | `CVE-2026-24486` / `GHSA-wp53-j4wj-2cfg` | `0.0.22` |
| `python-multipart` | `0.0.9` | `CVE-2026-40347` / `GHSA-mj87-hwqh-73pj` | `0.0.26` |
| `python-multipart` | `0.0.9` | `CVE-2026-42561` / `GHSA-pp6c-gr5w-3c5g` | `0.0.27` |
| `starlette` | `0.37.2` | `PYSEC-2026-161` / `CVE-2026-48710` / `GHSA-86qp-5c8j-p5mr` | `1.0.1` |
| `starlette` | `0.37.2` | `PYSEC-2026-161` / `CVE-2026-48710` / `GHSA-86qp-5c8j-p5mr` | `1.0.1` |
| `starlette` | `0.37.2` | `CVE-2024-47874` / `GHSA-f96h-pmfr-66vw` | `0.40.0` |
| `starlette` | `0.37.2` | `CVE-2025-54121` / `GHSA-2c2j-9gv5-cj73` | `0.47.2` |

Note: `pip-audit` emitted `PYSEC-2026-161` twice in the JSON result, and the
tool counted both entries in its 9-vulnerability total.

## Version Changes

| Package | Before | After | Reason |
|---|---:|---:|---|
| `fastapi` | `0.111.0` | `0.136.3` | Required to move resolved Starlette above vulnerable versions. |
| `python-dotenv` | `1.0.1` | `1.2.2` | Fixes `CVE-2026-28684`. |
| `python-multipart` | `0.0.9` | `0.0.27` | Fixes all audited multipart DoS/path traversal advisories. |
| `starlette` | transitive `0.37.2` | direct `1.2.1` | Fixes Host-header auth-bypass class advisory and multipart DoS advisories. |
| `pyjwt` | transitive `2.13.0` | direct `2.13.0` | Explicit safe pin for JWT audit item; no first-party Python use found. |
| `cryptography` | transitive `48.0.0` | direct `48.0.0` | Explicit safe pin above requested `46.0.7`; no first-party Python use found. |
| `lxml` | transitive `6.1.1` | direct `6.1.1` | Explicit safe pin above requested `6.1.0`; no first-party Python use found. |
| `authlib` | absent | absent | Not in resolved `apps/api` dependency graph; no first-party Python use found. |

## Verification

Dependency install and consistency:

```bash
apps/api/venv/bin/python -m pip install -r apps/api/requirements.txt
apps/api/venv/bin/python -m pip check
```

Result: requirements installed from the edited file; `pip check` reported
`No broken requirements found.`

Full API test suite:

```bash
PYTHONPATH=apps/api apps/api/venv/bin/python -m pytest apps/api/tests apps/api/test_pr_s8.py
```

Result: `569 passed, 186 warnings in 278.96s (0:04:38)`.

During the first full run, `apps/api/test_pr_s8.py` had 4 stale failures because
it called `_get_timeseries_batch()` without the current keyword-only
`user_id` and `repos` arguments. The test was updated to call the current helper
contract through the real SQLite worker repository. A focused rerun of that file
passed: `8 passed in 0.79s`.

Targeted auth/upload/JWT/crypto/XML probes:

| Probe | Result |
|---|---|
| `/health` without `x-floom-secret` | PASS |
| `/workers` without `x-floom-secret` returns 401 | PASS |
| `/workers` with wrong `x-floom-secret` returns 403 | PASS |
| `/workers` with correct `x-floom-secret` returns 200 | PASS |
| malformed `Host: example.com/health?x=` with wrong secret remains forbidden | PASS |
| multipart `/uploads` with `python-multipart==0.0.27` returns 200 and SHA-256 id | PASS |
| PyJWT HS256 encode/decode round trip | PASS |
| PyJWT rejects wrong HMAC secret | PASS |
| Cryptography Ed25519 sign/verify | PASS |
| lxml parse with `resolve_entities=False` | PASS |

Resolved versions in the targeted probe:

```text
fastapi==0.136.3
starlette==1.2.1
python-multipart==0.0.27
python-dotenv==1.2.2
PyJWT==2.13.0
cryptography==48.0.0
lxml==6.1.1
authlib: absent from resolved apps/api environment
```

## After Scan

Command:

```bash
python3 -m pip_audit -r apps/api/requirements.txt --format json --progress-spinner off
```

Result: `No known vulnerabilities found`.

Residual vulnerabilities: none reported by `pip-audit` for the edited
`apps/api/requirements.txt` resolve.

## Notes

- No secret values were written to this report.
- No deploy was performed.
- The branch remains unmerged.
