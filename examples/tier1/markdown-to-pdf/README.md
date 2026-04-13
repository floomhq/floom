# markdown-to-pdf

Convert Markdown text to a styled PDF document.

Uses [Python-Markdown](https://python-markdown.github.io/) + [WeasyPrint](https://weasyprint.org/).

## Example

```bash
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{"markdown": "# Hello\n\nThis is **bold** and `code`.", "page_size": "A4"}' \
  | jq -r '.pdf_base64' | base64 -d > output.pdf
```

## Notes

- Supports GFM tables, fenced code blocks, and syntax highlighting
- Supply a `css` string to override the default stylesheet
- Requires system packages: `libpango-1.0-0 libpangoft2-1.0-0`
