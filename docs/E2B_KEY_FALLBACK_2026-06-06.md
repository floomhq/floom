# E2B API Key Fallback - 2026-06-06

## Summary

Workeros now creates E2B sandboxes with an ordered set of API keys instead of
relying on the ambient `E2B_API_KEY` environment variable. The engine tries the
first key and falls back to the next configured key only when E2B reports
rate-limit, quota-exhaustion, payment-limit, HTTP 402, or HTTP 429 failures.

This is fallback, not rotation. A healthy primary key continues to serve all
sandbox creates. The fallback key is used only after the current key fails with
a quota/rate-limit style error.

## Configuration

Normal two-key configuration:

```dotenv
E2B_API_KEY=<primary key>
E2B_API_KEY_FALLBACK=<fallback key>
```

Optional ordered-list configuration for operators with more than two keys:

```dotenv
E2B_API_KEYS=<key 1>,<key 2>,<key 3>
```

When both styles are present, the effective order is:

1. Values from `E2B_API_KEYS`
2. `E2B_API_KEY`
3. `E2B_API_KEY_FALLBACK`

Duplicate values are ignored after their first occurrence. Secret values are never logged by the fallback path.

## Error Behavior

If one key returns a quota/rate-limit style error and another configured key succeeds, the run continues normally.

If every configured key is exhausted, the run fails with:

- `error_code`: `e2b_quota_exhausted`
- message: all configured E2B API keys are rate-limited or quota-exhausted

Non-quota E2B failures do not advance to another key. They fail through the existing E2B sandbox error path.

## Verification

The focused unit test is:

```bash
pytest tests/test_e2b_artifact_collection.py::test_e2b_driver_falls_back_to_next_key_on_quota_error
```

Masked key-presence checks can count configured keys without printing values:

```bash
python3 - <<'PY'
import os
keys = [os.environ.get("E2B_API_KEY"), os.environ.get("E2B_API_KEY_FALLBACK")]
loaded = [key for key in keys if key]
print({"e2b_key_count": len(loaded), "masked": ["***" for _ in loaded]})
PY
```

Production verification also includes a real E2B worker run to confirm sandbox creation still succeeds.
