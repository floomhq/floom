# qr-gen

Generate a QR code PNG from any text or URL.

Uses [qrcode](https://github.com/lincolnloop/python-qrcode) with Pillow rendering.

## Example

```bash
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{"text": "https://floom.dev", "size": 10, "border": 4, "color": "#000000", "background": "#ffffff"}' \
  | jq -r '.image_base64' | base64 -d > qr.png
```

## Notes

- `size` controls QR version (1–40); higher = more data capacity
- `color` and `background` accept hex color strings
