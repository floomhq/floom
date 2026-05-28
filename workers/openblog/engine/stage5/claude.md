# Stage 5: Internal Links

Embeds internal links from sitemap into article content using Gemini for natural anchor text placement.

## Purpose

1. **Build Link Pool**: Combine batch siblings + sitemap URLs
2. **Find Placements**: Gemini identifies optimal anchor text and positions
3. **Apply Embeddings**: Surgical find/replace to add `<a href>` tags

## AI Calls

- **1x Gemini**: Link embedding suggestions with structured JSON schema (no grounding needed)

Uses `generate_with_schema()` for typed response validation.

## Files

| File | Purpose |
|------|---------|
| `stage_5.py` | InternalLinker class, main orchestrator |
| `models.py` | Stage5Input, Stage5Output, LinkCandidate, LinkEmbedding |
| `constants.py` | Imports from shared |
| `__init__.py` | Package exports |

## Input Schema (Stage5Input)

```json
{
  "article": { /* ArticleOutput dict from Stage 4 */ },
  "current_href": "/magazine/sales-automation",
  "company_url": "https://example.com",
  "batch_siblings": [
    {"keyword": "CRM Integration", "href": "/magazine/crm-integration"},
    {"keyword": "Lead Scoring", "href": "/magazine/lead-scoring"}
  ],
  "sitemap_blog_urls": ["https://example.com/blog/post-1", ...],
  "sitemap_resource_urls": ["https://example.com/case-studies/..."]
}
```

## Output Schema (Stage5Output)

```json
{
  "article": { /* ArticleOutput with embedded links */ },
  "links_added": 4,
  "links_report": {
    "pool_size": 25,
    "suggested": 5,
    "applied": 4
  }
}
```

## Linkable Fields

Only these content fields receive internal links:
- `Intro`
- `section_01_content` through `section_09_content`

## Link Pool Priority

1. **Batch Siblings** (highest priority) - other articles in same generation batch
2. **Sitemap Blog URLs** - existing blog posts from sitemap
3. **Sitemap Resource URLs** - case studies, whitepapers, etc.

## Embedding Format

Gemini returns surgical find/replace pairs:

```json
{
  "embeddings": [
    {
      "field": "section_02_content",
      "find": "customer relationship management",
      "replace": "<a href=\"/magazine/crm-integration\">customer relationship management</a>"
    }
  ]
}
```

## Usage

```python
from stage_5 import InternalLinker, run_stage_5

# Quick function (async)
result = await run_stage_5({
    "article": article_dict,
    "current_href": "/magazine/my-article",
    "company_url": "https://example.com",
    "batch_siblings": [...],
    "sitemap_blog_urls": [...],
    "sitemap_resource_urls": [...]
})

# Class-based (async)
linker = InternalLinker()
output = await linker.run(Stage5Input(...))
```

## Link Rules (enforced by Gemini)

- 3-5 links total across all sections
- Natural anchor text (NOT "click here")
- Spread across DIFFERENT sections
- No duplicate URLs
- Anchor text: 2-5 words, complete phrases
- Only link phrases that relate to target page topic

## CLI

```bash
python stage_5.py input.json
```
