# Stage 1: Set Context

Sets up all context for blog generation. Runs once per batch, not per article.

## Purpose

1. **Job Input**: Keywords (batch), company URL, language, market, word counts, custom instructions
2. **Company Context**: From provided data OR OpenContext (Gemini + Google Search)
3. **Sitemap**: Crawled and labeled URLs for internal linking in Stage 5

## AI Calls

- **0** if company_context is provided in input
- **1** if OpenContext needs to be called (Gemini with URL Context + Google Search)

## Files

| File | Purpose |
|------|---------|
| `stage_1.py` | Main orchestrator, CLI entry point |
| `opencontext.py` | Extracts company context using Gemini |
| `sitemap_crawler.py` | Crawls sitemap, labels URLs by type |
| `models.py` | Pydantic schemas (Stage1Input, Stage1Output, CompanyContext, KeywordConfig) |
| `constants.py` | Imports from shared |

## Input Schema (Stage1Input)

```json
{
  "keywords": ["keyword 1", "keyword 2"],
  "company_url": "https://example.com",
  "language": "en",
  "market": "US",
  "default_word_count": 2000,
  "batch_instructions": "Focus on practical examples",
  "company_context": null
}
```

## Instructions (Two Levels)

Instructions work at two levels that get **combined**:

| Level | Field | Applies To |
|-------|-------|------------|
| Batch | `batch_instructions` | ALL articles in batch |
| Keyword | `keyword_instructions` (per keyword) | Specific article only |

When both are provided, they're combined:
```
{batch_instructions}

Additional for this article: {keyword_instructions}
```

### Example: Combined Instructions

```json
{
  "keywords": [
    "sales automation",
    {"keyword": "crm integration", "keyword_instructions": "Focus on Salesforce and HubSpot"}
  ],
  "batch_instructions": "Target B2B SaaS companies, include ROI metrics"
}
```

Results in:
- **sales automation**: "Target B2B SaaS companies, include ROI metrics"
- **crm integration**: "Target B2B SaaS companies, include ROI metrics\n\nAdditional for this article: Focus on Salesforce and HubSpot"

## Keywords Format

Keywords can be provided in three formats:

### Simple strings (uses batch defaults)
```json
{
  "keywords": ["keyword 1", "keyword 2"],
  "default_word_count": 2000,
  "batch_instructions": "Include case studies"
}
```

### Objects with per-keyword overrides
```json
{
  "keywords": [
    {"keyword": "short topic", "word_count": 1000},
    {"keyword": "deep dive topic", "word_count": 4000, "keyword_instructions": "Include technical details"}
  ],
  "default_word_count": 2000,
  "batch_instructions": "B2B focus for all"
}
```

### Mixed format
```json
{
  "keywords": [
    "uses defaults only",
    {"keyword": "custom word count", "word_count": 3000},
    {"keyword": "extra instructions", "keyword_instructions": "Compare competitors"}
  ],
  "default_word_count": 2000,
  "batch_instructions": "General instructions for all"
}
```

## Word Count Behavior

Word count uses **override** logic (not combined):
- If keyword specifies `word_count` → use keyword value
- Otherwise → use `default_word_count`

## Output Schema (Stage1Output)

```json
{
  "job_id": "uuid",
  "articles": [
    {
      "keyword": "...",
      "slug": "...",
      "href": "/magazine/...",
      "word_count": 2000,
      "keyword_instructions": "..."
    }
  ],
  "language": "en",
  "market": "US",
  "company_context": {
    "company_name": "...",
    "industry": "...",
    "products": [...],
    "target_audience": "...",
    "tone": "professional",
    "competitors": ["Competitor 1", "Competitor 2"],
    "voice_persona": {...},
    "authors": [
      {
        "name": "John Smith",
        "title": "CEO",
        "bio": "Short bio...",
        "image_url": "https://...",
        "linkedin_url": "https://linkedin.com/in/...",
        "twitter_url": "https://twitter.com/..."
      }
    ],
    "visual_identity": {
      "brand_colors": ["#1E40AF", "#3B82F6"],
      "secondary_colors": ["#F59E0B", "#10B981"],
      "visual_style": "Modern minimalist with bold accents",
      "design_elements": ["gradients", "geometric shapes", "icons"],
      "typography_style": "Modern sans-serif (Inter, SF Pro)",
      "mood": "Professional, innovative, trustworthy",
      "image_style_prompt": "Modern minimalist illustration with blue gradient...",
      "blog_image_examples": [
        {
          "url": "https://example.com/blog/hero-image.jpg",
          "description": "Abstract blue gradient with geometric shapes",
          "image_type": "hero"
        }
      ],
      "avoid_in_images": ["stock photo clichés", "cluttered compositions"]
    }
  },
  "sitemap": {
    "total_pages": 150,
    "blog_urls": [...],
    "product_urls": [...],
    "resource_urls": [...]
  },
  "opencontext_called": true,
  "ai_calls": 1
}
```

## ArticleJob Fields

| Field | Type | Description |
|-------|------|-------------|
| `keyword` | string | Primary SEO keyword |
| `slug` | string | URL-safe slug |
| `href` | string | Full internal path |
| `word_count` | int | Target word count (default or per-keyword override) |
| `keyword_instructions` | string | Combined instructions (batch + keyword) |

## Sitemap URL Categories

- `blog` - /blog/, /news/, /articles/
- `product` - /products/, /solutions/, /pricing/
- `service` - /services/, /consulting/
- `docs` - /docs/, /help/, /faq/
- `resource` - /case-studies/, /whitepapers/
- `company` - /about/, /team/, /careers/
- `legal` - /privacy/, /terms/
- `contact` - /contact/, /support/
- `landing` - /lp/, /campaigns/

## Usage

```bash
# CLI with defaults
python stage_1.py --url https://example.com --keywords "keyword 1" "keyword 2"

# From file with overrides
python stage_1.py --input batch.json --output stage1_output.json

# As module
from stage_1 import run_stage_1, Stage1Input
output = await run_stage_1(Stage1Input(
    keywords=[
        "simple keyword",
        {"keyword": "custom", "word_count": 3000}
    ],
    company_url="https://example.com",
    default_word_count=2000,
    batch_instructions="Include statistics"
))
```

## URL Validation

The sitemap crawler can validate URLs with HEAD requests:

```python
from sitemap_crawler import crawl_sitemap

data = await crawl_sitemap(
    company_url="https://example.com",
    validate_urls=True,           # Enable HEAD request validation
    validation_sample_size=50,    # Max URLs to validate
)
```

## Visual Identity (for Image Generation)

OpenContext extracts visual identity from the company website for consistent image generation in Stage 2.

### VisualIdentity Fields

| Field | Type | Description |
|-------|------|-------------|
| `brand_colors` | List[str] | Primary brand colors as hex codes |
| `secondary_colors` | List[str] | Secondary/accent colors as hex codes |
| `visual_style` | string | Overall style (minimalist, bold, corporate, playful) |
| `design_elements` | List[str] | Common elements (gradients, icons, illustrations) |
| `typography_style` | string | Typography feel (modern sans-serif, classic serif) |
| `mood` | string | Overall mood (professional, friendly, innovative) |
| `image_style_prompt` | string | Base prompt for AI image generation |
| `blog_image_examples` | List[BlogImageExample] | Existing blog images for reference |
| `avoid_in_images` | List[str] | Elements to avoid in generated images |

### BlogImageExample Fields

| Field | Type | Description |
|-------|------|-------------|
| `url` | string | Image URL from existing blog post |
| `description` | string | AI description of visual style, colors, composition |
| `image_type` | string | Type: hero, inline, infographic, thumbnail |

### How It Works

1. OpenContext analyzes the company website design
2. Extracts brand colors from CSS/design elements
3. Navigates to blog/magazine section
4. Finds and describes 3-5 existing blog images
5. Creates `image_style_prompt` based on visual patterns
6. Stage 2 uses this for consistent Imagen prompts

## Author Extraction

OpenContext extracts blog authors from existing articles (if found):

### AuthorInfo Fields

| Field | Type | Description |
|-------|------|-------------|
| `name` | string | Author's full name (required) |
| `title` | string | Job title/role |
| `bio` | string | Short author bio |
| `image_url` | string | Profile image URL |
| `linkedin_url` | string | LinkedIn profile URL |
| `twitter_url` | string | Twitter/X profile URL |

### How It Works

1. OpenContext navigates to blog/magazine section
2. Finds author bylines on recent articles
3. Extracts available author information
4. Only includes authors with verified names (no hallucination)
5. Empty strings for fields not found

## Instructions Examples

| Use Case | Instructions |
|----------|--------------|
| B2B Focus | "Target enterprise decision-makers, include ROI examples" |
| Technical | "Include code examples and technical specifications" |
| Beginner | "Explain concepts simply, avoid jargon" |
| Local SEO | "Include references to {city} market" |
| Comparison | "Compare with top 3 competitors" |
