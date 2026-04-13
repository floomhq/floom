# csv-to-json

Convert CSV text to a JSON array of objects, with automatic type inference.

Uses Python's stdlib `csv` module — no heavy dependencies.

## Example

```bash
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{
    "csv_content": "name,age,active\nAlice,30,true\nBob,25,false",
    "delimiter": ",",
    "has_header": true
  }'
```

## Notes

- Type inference: integers, floats, booleans (`true`/`false`/`yes`/`no`), nulls (`null`/`none`/`na`), strings
- Empty rows are skipped
- `has_header: false` generates column names as `col0`, `col1`, ...
