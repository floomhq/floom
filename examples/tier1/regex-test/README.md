# regex-test

Test a regular expression against input text and return all matches with groups.

Uses Python's stdlib `re` module with SIGALRM-based ReDoS protection.

## Example

```bash
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{
    "pattern": "\\b[\\w.+-]+@[\\w-]+\\.[\\w.]+\\b",
    "input": "Reach us at hello@floom.dev or support@floom.dev",
    "flags": "i"
  }'
```

## Notes

- Supported flags: `i` (IGNORECASE), `m` (MULTILINE), `s` (DOTALL), `x` (VERBOSE)
- Execution is capped at 5 seconds to guard against ReDoS
- Input is capped at 100,000 characters
