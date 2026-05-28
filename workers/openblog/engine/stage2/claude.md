# Stage 2: Blog Generation + Image Creation

Generates a complete blog article using Gemini AI with Google Search grounding, plus 3 images using Google Imagen.

## Purpose

1. **Article Generation**: Full blog post with 40+ fields (headline, sections, FAQs, meta tags)
2. **Image Generation**: 3 images (hero, mid, bottom) using Imagen - optional

## AI Calls

- **1x Gemini**: Blog article generation with URL Context + Google Search grounding
- **3x Imagen**: Hero, mid, and bottom images (can be skipped with `skip_images=True`)

## Files

| File | Purpose |
|------|---------|
| `stage_2.py` | Main orchestrator, CLI entry point |
| `blog_writer.py` | Gemini article generation using shared GeminiClient |
| `article_schema.py` | ArticleOutput Pydantic model (40+ fields) |
| `image_creator.py` | Google Imagen image generation |
| `image_prompts.py` | Image prompt templates by position |
| `constants.py` | Imports from shared |

## Input Schema (Stage2Input)

```json
{
  "keyword": "primary seo keyword",
  "company_context": {
    "company_name": "...",
    "industry": "...",
    "products": [...],
    "target_audience": "...",
    "tone": "professional",
    "authors": [
      {
        "name": "John Smith",
        "title": "CEO",
        "bio": "Short bio...",
        "image_url": "https://...",
        "linkedin_url": "https://linkedin.com/in/...",
        "twitter_url": "https://twitter.com/..."
      }
    ]
  },
  "visual_identity": {
    "brand_colors": ["#1E40AF"],
    "image_style_prompt": "..."
  },
  "language": "en",
  "country": "United States",
  "word_count": 2000,
  "custom_instructions": "Batch-level instructions (optional)",
  "keyword_instructions": "Keyword-specific instructions (optional)",
  "skip_images": false,
  "job_id": "from-stage-1"
}
```

## Output Schema (Stage2Output)

```json
{
  "job_id": "uuid",
  "keyword": "...",
  "article": {
    "Headline": "...",
    "Subtitle": "...",
    "Teaser": "...",
    "Direct_Answer": "...",
    "Intro": "...",
    "Meta_Title": "...",
    "Meta_Description": "...",
    "section_01_title": "...",
    "section_01_content": "<p>HTML content</p>",
    "section_02_title": "...",
    "section_02_content": "...",
    // ... up to section_09
    "key_takeaway_01": "...",
    "key_takeaway_02": "...",
    "key_takeaway_03": "...",
    "paa_01_question": "...",
    "paa_01_answer": "...",
    // ... 4 PAAs
    "faq_01_question": "...",
    "faq_01_answer": "...",
    // ... up to 6 FAQs
    "image_01_url": "...",
    "image_01_alt_text": "...",
    // ... 3 images
    "tables": [{"title": "...", "headers": [...], "rows": [...]}],
    "Sources": [{"title": "Source Name", "url": "https://..."}],
    "Search_Queries": "Q1: query used"
  },
  "images": [...],
  "ai_calls": 4,
  "images_generated": 3
}
```

Note: `ai_calls` only counts successful API calls (1 for article + successful image generations).

## Article Content Rules

- Section content uses HTML tags: `<p>`, `<ul>`, `<li>`, `<ol>`, `<strong>`, `<em>`
- No markdown in section content
- Sources are structured as `[{title, url}]` list (clickable in HTML)
- Tables are structured as `[{title, headers, rows}]` for comparisons
- 4-6 content sections, 4 PAAs, 5-6 FAQs, 3 key takeaways
- Each section should have visual variety (not all paragraphs)

## Usage

```bash
# CLI
python stage_2.py --keyword "sales automation ai" --company-url https://example.com

# With Stage 1 output
python stage_2.py --input stage1_output.json --keyword "sales automation ai"

# Skip images
python stage_2.py --keyword "topic" --skip-images

# As module
from stage_2 import run_stage_2, Stage2Input
output = await run_stage_2(Stage2Input(...))
```

## Image Positions

| Position | Placement | Prompt Style |
|----------|-----------|--------------|
| hero | After headline | Wide establishing shot, overview |
| mid | After section 3 | Close-up detail, hands-on action |
| bottom | End of article | Forward-looking, success outcome |

Images are generated with `NO text, NO words, NO letters, NO logos` unless company context explicitly requests text in images.
