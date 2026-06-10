# Workeros marketing assets

On-brand banners for Workeros ("hire AI workers"). Design system mirrors the app: neutral surfaces, one Floom-blue accent (`#3E6FE0` / `#5B8DEF`), the Emily sparkle mark, Geist/Inter type.

| File | Size | Use |
|---|---|---|
| `og-image.svg` / `.png` | 1200×630 | Social / link-preview card (OG / Twitter), dark |
| `og-image-light.svg` / `.png` | 1200×630 | Same, light variant |
| `hero-banner.svg` / `.png` | 1600×500 | Landing / README hero, dark |

Headline: **Hire AI workers for your company** · **Hire AI workers that actually run.**
Subline: *Triggered, tooled, and accountable.*

SVGs are the source of truth (crisp, editable). Regenerate PNGs with:

```bash
rsvg-convert -o og-image.png og-image.svg
rsvg-convert -o hero-banner.png hero-banner.svg
```

Not final — copy, dimensions (e.g. 1080×1080 social, 1500×500 X header), and a real Emily avatar can be added on request.
