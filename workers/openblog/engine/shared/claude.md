# Shared Components

Unified components used across all pipeline stages for consistency.

## Files

| File | Purpose |
|------|---------|
| `gemini_client.py` | Unified Gemini client with URL Context + Google Search + JSON schema |
| `models.py` | ArticleOutput schema (40+ fields) |
| `field_utils.py` | DRY field derivation from ArticleOutput |
| `html_renderer.py` | Render article to HTML |
| `article_exporter.py` | Export to multiple formats (HTML, MD, JSON, CSV, XLSX, PDF) |
| `prompt_loader.py` | Load prompts from text files |
| `constants.py` | GEMINI_MODEL, MAX_SITEMAP_URLS |
| `__init__.py` | Package exports |

## GeminiClient

All stages use this client for Gemini API calls:

```python
from shared.gemini_client import GeminiClient

client = GeminiClient(api_key="...")  # or uses GEMINI_API_KEY env var

# With grounding (URL Context + Google Search)
result = await client.generate(
    prompt="Analyze https://example.com",
    use_url_context=True,
    use_google_search=True,
    json_output=True,
    temperature=0.3,
)

# Without grounding (faster, for surgical operations)
result = await client.generate(
    prompt="Fix this JSON...",
    use_url_context=False,
    use_google_search=False,
    json_output=True,
)
```

## GeminiClient Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `prompt` | required | The prompt to send |
| `use_url_context` | `True` | Enable URL Context tool for fetching web pages |
| `use_google_search` | `True` | Enable Google Search tool for grounding |
| `json_output` | `True` | Request structured JSON output |
| `extract_sources` | `False` | Extract real URLs from grounding metadata |
| `temperature` | `0.3` | Generation temperature (0-1) |
| `max_tokens` | `8192` | Maximum output tokens |
| `timeout` | `120` | Request timeout in seconds |

## Source Extraction

For Stage 2, extract real URLs from Gemini's grounding metadata:

```python
result = await client.generate(
    prompt=blog_prompt,
    use_google_search=True,
    extract_sources=True,  # Extract verified URLs
)

# Access extracted sources
if "_grounding_sources" in result:
    formatted = client.format_sources(result["_grounding_sources"])
    # Returns: "[1]: URL - title\n[2]: URL - title"
```

## Constants

```python
from shared.constants import GEMINI_MODEL, MAX_SITEMAP_URLS

# GEMINI_MODEL = "gemini-3-flash-preview"
# MAX_SITEMAP_URLS = 10000
```

## ArticleOutput Schema

40+ fields for complete blog article:

```python
from shared.models import ArticleOutput

article = ArticleOutput(
    Headline="...",
    Subtitle="...",
    Teaser="...",
    Direct_Answer="...",
    Intro="...",
    Meta_Title="...",
    Meta_Description="...",
    section_01_title="...",
    section_01_content="<p>...</p>",
    # ... sections 02-09
    key_takeaway_01="...",
    key_takeaway_02="...",
    key_takeaway_03="...",
    paa_01_question="...",
    paa_01_answer="...",
    # ... PAAs 02-04
    faq_01_question="...",
    faq_01_answer="...",
    # ... FAQs 02-06
    image_01_url="...",
    image_01_alt_text="...",
    image_01_credit="...",
    # ... images 02-03
    Sources="[1]: URL - description",
    Search_Queries="Q1: query used",
)

# Helper methods
article.count_sections()  # Returns count of non-empty sections
article.count_faqs()      # Returns count of non-empty FAQs
```

## Usage Across Stages

| Stage | Grounding | JSON Output | Purpose |
|-------|-----------|-------------|---------|
| 1 (OpenContext) | URL + Search | `json_output=True` | Extract company info from website |
| 2 (Blog Writer) | URL + Search | `json_output=True` | Generate article with real sources |
| 3 (Quality Check) | None | `generate_with_schema()` | Surgical text fixes |
| 4 (URL Verify) | URL or Search | `generate_with_schema()` | Verify content / find replacements |
| 5 (Internal Links) | None | `generate_with_schema()` | Find anchor text placements |

## Structured Schema Output

Stages 3-5 use `generate_with_schema()` for typed JSON responses:

```python
from google.genai import types

response_schema = types.Schema(
    type=types.Type.OBJECT,
    properties={
        "fixes": types.Schema(
            type=types.Type.ARRAY,
            items=fix_schema,
        ),
    },
    required=["fixes"],
)

result = await client.generate_with_schema(
    prompt=prompt,
    response_schema=response_schema,
    use_url_context=False,
    use_google_search=False,
)
```

## Article Exporter

Export articles to multiple formats:

```python
from shared.article_exporter import ArticleExporter

exporter = ArticleExporter(output_dir="results/")

# Export single article
exporter.export_article(article_dict, keyword, formats=["html", "markdown", "json"])

# Export batch
exporter.export_batch(articles, formats=["csv", "xlsx", "pdf"])
```

### Supported Formats

| Format | Extension | Description |
|--------|-----------|-------------|
| html | .html | Full HTML page with styling |
| markdown | .md | Markdown document |
| json | .json | Raw JSON data |
| csv | .csv | Flat CSV export |
| xlsx | .xlsx | Excel spreadsheet |
| pdf | .pdf | PDF document |

## HTML Renderer

Render ArticleOutput to styled HTML:

```python
from shared.html_renderer import HTMLRenderer

renderer = HTMLRenderer()
html = renderer.render(article_dict)
```

## Field Utils

DRY field iteration for ArticleOutput:

```python
from shared.field_utils import iter_content_fields, iter_section_fields

# Iterate over all content fields
for field, content in iter_content_fields(article):
    print(f"{field}: {content[:50]}...")

# Iterate over section fields only
for field, content in iter_section_fields(article):
    print(f"{field}: {content[:50]}...")
```

## Prompt Loader

Load prompts from text files with variable substitution:

```python
from shared.prompt_loader import load_prompt

prompt = load_prompt(
    "stage3",
    "quality_check",
    content=content_text,
    keyword=keyword,
    language=language,
)
```
