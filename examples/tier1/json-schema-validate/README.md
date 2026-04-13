# json-schema-validate

Validate a JSON document against a JSON Schema and return structured errors.

Uses [jsonschema](https://python-jsonschema.readthedocs.io/) (Draft 7).

## Example

```bash
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{
    "document": {"name": "Alice", "age": "not-a-number"},
    "schema": {
      "type": "object",
      "properties": {
        "name": {"type": "string"},
        "age": {"type": "integer"}
      },
      "required": ["name", "age"]
    }
  }'
```

## Notes

- Returns `valid: true` and empty `errors` on success
- Each error includes a JSON path and human-readable message
