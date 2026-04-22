#!/usr/bin/env bash
#
# Render the /public/cards/<slug>.webp thumbnails used by HeroAppTiles
# on the landing page. The HTML files in this directory are static
# mocks of each showcase app's real output shape (ranked table,
# comparison scorecard, candidate list) — NOT screenshots of the live
# app. We use static mocks instead of live captures because:
#
#   1. The live demos are rate-limited (5 free runs → BYOK modal),
#      and regenerating thumbnails should not burn Gemini quota.
#   2. Live output varies run-to-run, which makes diffs unreadable.
#   3. The HTML mock is a single source of truth we can update when
#      the product UI changes, independent of backend availability.
#
# If a showcase app's output shape changes, update the matching HTML
# in this directory and re-run this script. The WebP output is
# committed to the repo so the landing renders with zero fetch cost.
#
# Requires: google-chrome (headless), ImageMagick (`convert`), cwebp.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../../apps/web/public/cards"
mkdir -p "$OUT"

for slug in lead-scorer competitor-analyzer resume-screener; do
  echo "Rendering $slug..."
  google-chrome \
    --headless=new \
    --disable-gpu \
    --no-sandbox \
    --hide-scrollbars \
    --window-size=1280,720 \
    --force-device-scale-factor=2 \
    --screenshot="/tmp/${slug}-raw.png" \
    "file://$HERE/${slug}.html" 2>/dev/null
  # Downscale 2560x1440 → 1280x720 (2x retina for a 640x360 display img)
  convert "/tmp/${slug}-raw.png" -resize 1280x720 "/tmp/${slug}-1280.png"
  cwebp -q 85 -m 6 -sharp_yuv "/tmp/${slug}-1280.png" -o "$OUT/${slug}.webp" >/dev/null 2>&1
  echo "  -> $OUT/${slug}.webp ($(stat -c%s "$OUT/${slug}.webp") bytes)"
  rm -f "/tmp/${slug}-raw.png" "/tmp/${slug}-1280.png"
done

echo "Done. Committed WebPs will be picked up by HeroAppTiles.tsx."
