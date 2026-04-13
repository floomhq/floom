# favicon-gen

Generate a multi-size favicon.ico from a source PNG image.

Uses [Pillow](https://python-pillow.org/) to embed multiple resolutions into a single .ico file.

## Example

```bash
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{"image_base64": "<base64-png>", "sizes": [16, 32, 48, 64]}' \
  | jq -r '.favicon_ico_base64' | base64 -d > favicon.ico
```

## Notes

- Input must be a PNG; RGBA is preserved in the ICO frames
- Default sizes: 16, 32, 48, 64 — standard browser favicon sizes
- Output is a single `.ico` file containing all requested sizes
