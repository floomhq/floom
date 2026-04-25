# LinkedIn Profile Roaster

Paste profile text (headline, About, and 1-2 roles) and get:

- `roast`: 3-5 specific observations with one-line stings
- `rewrites`: exactly 3 targeted rewrites (`headline`, `about_intro`, `experience_bullet`)
- `top_tip`: the single biggest improvement to make next

`main.py` follows the standard Floom demo contract: JSON in via `argv[1]`, and a final `__FLOOM_RESULT__{...}` line on stdout.

If `GEMINI_API_KEY` is missing, the app returns a deterministic dry-run payload. If the input matches the baked sample input, `sample-cache.json` returns instantly.
