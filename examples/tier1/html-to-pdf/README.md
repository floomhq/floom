# html-to-pdf

Convert an HTML string or URL to a PDF document.

Uses [WeasyPrint](https://weasyprint.org/) for high-quality HTML/CSS rendering.

## Example

```bash
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{"html": "<h1>Hello World</h1><p>This is a PDF.</p>", "page_size": "A4", "margin_mm": 20}' \
  | jq -r '.pdf_base64' | base64 -d > output.pdf
```

## Notes

- Requires system packages: `libpango-1.0-0 libpangoft2-1.0-0` (included in Docker build)
- Provide either `html` (raw string) or `url` (fetched via httpx). `html` takes precedence.
