# Email Signature Generator

Generate a professional email signature in three paste-ready formats:

- `html` (table-based for Gmail/Outlook/Apple Mail compatibility)
- `plaintext`
- `markdown`

Default mode is deterministic and offline (`tagline_mode=none`).
Optional `tagline_mode=ai` makes one Gemini call (`gemini-2.5-flash-lite`) to generate a short professional tagline (`<=80` chars).

## Inputs

- `full_name` (required, 2-80 chars)
- `title` (optional, 0-80 chars)
- `company` (optional, 0-80 chars)
- `email` (optional, valid email format)
- `phone` (optional, 0-30 chars)
- `calendar_url` (optional, must be HTTPS)
- `website_url` (optional, must be HTTPS)
- `linkedin_url` (optional, must be HTTPS and include `linkedin.com`)
- `tagline_mode` (`none` or `ai`, default `none`)

## Output shape

```json
{
  "html": "...",
  "plaintext": "...",
  "markdown": "...",
  "meta": {
    "has_tagline": false,
    "tagline_source": "none",
    "made_with_floom": "https://floom.dev/p/email-signature"
  }
}
```

## Made-with-Floom attribution

All three outputs include the required attribution footer:

`Made with Floom · floom.dev/p/email-signature`

This footer is intentionally always-on for the free tool and cannot be disabled.

## Run locally

```bash
cd examples/email-signature
pip install -r requirements.txt

# Deterministic (offline)
python3 main.py '{"action":"generate","inputs":{"full_name":"Jane Doe","title":"Founder","company":"Acme Labs","email":"jane@acme.com","phone":"+1 415 555 0101","calendar_url":"https://cal.com/janedoe","website_url":"https://acme.com","linkedin_url":"https://www.linkedin.com/in/janedoe","tagline_mode":"none"}}'

# Optional AI tagline
GEMINI_API_KEY=your-key python3 main.py '{"action":"generate","inputs":{"full_name":"Jane Doe","title":"Founder","company":"Acme Labs","tagline_mode":"ai"}}'
```
