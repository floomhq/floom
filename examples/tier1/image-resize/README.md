# image-resize

Resize an image to target dimensions with configurable fit mode.

Uses [Pillow](https://python-pillow.org/) for image processing.

## Example

```bash
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{"image_base64": "<base64>", "width": 800, "height": 600, "fit": "contain", "format": "PNG"}' \
  | jq -r '.image_base64' | base64 -d > resized.png
```

## Fit modes

- `contain`: Shrinks to fit within bounds, preserves aspect ratio (default)
- `cover`: Crops to fill exactly the target dimensions
- `scale`: Stretches to exact dimensions (may distort)
