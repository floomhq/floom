# Stage 4: URL Verification

Validates source URLs in the article and finds replacements for dead/irrelevant links.

## Purpose

1. **Validate URLs**: Check if source URLs are accessible (HTTP status)
2. **Verify Relevance**: Use Gemini URL Context to check content relevance
3. **Find Replacements**: Use Google Search to find replacement sources for dead URLs

## AI Calls

- **2 max**: Batched calls regardless of URL count
  1. `find_replacements_batch`: Google Search for dead URL replacements
  2. `verify_urls_batch`: URL Context for content relevance verification
- Uses structured output with `types.Schema`

## Files

| File | Purpose |
|------|---------|
| `stage_4.py` | Main orchestrator, CLI entry point |
| `url_verifier.py` | URLVerifier class using shared GeminiClient |
| `url_extractor.py` | Extract URLs from article content |
| `http_checker.py` | HTTP HEAD/GET checks for URL accessibility |
| `models.py` | Stage4Input, Stage4Output, URLStatus schemas |
| `constants.py` | Imports from shared |

## URL Status Types

```python
class URLStatus(str, Enum):
    VALID = "valid"           # URL works, content relevant
    DEAD = "dead"             # URL returns 4xx/5xx
    IRRELEVANT = "irrelevant" # URL works but content not relevant
    REPLACED = "replaced"     # Dead URL replaced with new source
```

## Verification Result

```json
{
  "url": "https://example.com/article",
  "status": "valid",
  "content_relevant": true,
  "content_summary": "Article about sales automation trends",
  "replacement_url": null,
  "replacement_source": null,
  "replacement_reason": null,
  "error": null
}
```

## Usage

```python
from url_verifier import URLVerifier

verifier = URLVerifier()

# Batch content verification (one AI call for all URLs)
results = await verifier.verify_urls_batch(
    urls=["url1", "url2", "url3"],
    keyword="sales automation",
    max_urls=10
)
# Returns: {"url": {"content_relevant": bool, "content_summary": str, "relevance_reason": str}}

# Batch replacement search (one AI call for all dead URLs)
replacements = await verifier.find_replacements_batch(
    dead_urls=["url1", "url2", "url3"],
    keyword="sales automation",
    url_contexts={"url1": "surrounding sentence context"},  # Optional
    max_urls=10
)
# Returns: {"old_url": {"new_url": str, "source_name": str, "anchor_text": str, "reason": str}}
```

## Replacement Format

```json
{
  "new_url": "https://forbes.com/new-article",
  "source_name": "Forbes",
  "anchor_text": "Forbes research on productivity",
  "reason": "Covers same topic with updated statistics"
}
```

Note: `anchor_text` is context-aware and flows naturally in the surrounding sentence.

## Integration with Article

After verification, update the article's Sources field:

```python
# Original
article["Sources"] = "[1]: https://dead-link.com - Old source"

# After replacement
article["Sources"] = "[1]: https://forbes.com/new-article - Forbes"
```

## Source Preferences

When finding replacements, AI prefers (in order):
1. Industry blogs and publications (TechCrunch, Wired, company blogs)
2. Reputable news outlets (Forbes, Business Insider)
3. Official product/company pages
4. Tech publications (Ars Technica, ZDNet)

Avoided: Academic papers (arxiv), Wikipedia, social media, forums
