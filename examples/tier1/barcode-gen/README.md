# barcode-gen

Generate a CODE128, EAN13, or UPC-A barcode as a PNG image.

Uses [python-barcode](https://github.com/WhyNotHugo/python-barcode) with ImageWriter.

## Example

```bash
curl -X POST http://localhost:8000/run \
  -H "Content-Type: application/json" \
  -d '{"code_type": "CODE128", "value": "FLOOM-2025-001", "show_text": true}' \
  | jq -r '.image_base64' | base64 -d > barcode.png
```

## Notes

- EAN13 requires exactly 12 or 13 digits (check digit auto-calculated)
- UPC-A requires exactly 11 or 12 digits
- CODE128 accepts any ASCII string
