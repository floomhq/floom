# OpenBlog Neo

AI-powered blog generation pipeline using Gemini 3 Flash Preview with Google Search grounding.

## Features

- **5-Stage Pipeline**: Context → Generation → Quality → URL Verify → Internal Links
- **Google Search Grounding**: Real-time web research for accurate, sourced content
- **Parallel Processing**: Generate multiple articles simultaneously
- **Multiple Export Formats**: HTML, Markdown, JSON, CSV, XLSX, PDF
- **Image Generation**: Optional hero, mid, and bottom images via Google Imagen

## Architecture

```
Stage 1 (once per batch)
     ↓
┌────┴────┬─────────┐
▼         ▼         ▼
[Art 1]  [Art 2]  [Art 3]  ← parallel processing
  │         │         │
  ▼         ▼         ▼
Stage 2   Stage 2   Stage 2   ← Blog Gen + Images
  │         │         │
  ▼         ▼         ▼
Stage 3   Stage 3   Stage 3   ← Quality Check
  │         │         │
  ▼         ▼         ▼
Stage 4   Stage 4   Stage 4   ← URL Verify
  │         │         │
  ▼         ▼         ▼
Stage 5   Stage 5   Stage 5   ← Internal Links
  │         │         │
  ▼         ▼         ▼
Export    Export    Export    ← HTML/MD/JSON/CSV/XLSX/PDF
```

## Pipeline Stages

| Stage | Name | AI Calls | Purpose |
|-------|------|----------|---------|
| 1 | Set Context | 0-1 | Company context + authors + sitemap (runs once per batch) |
| 2 | Blog Gen + Images | 1-4 | Generate article with Gemini + 3 images with Imagen |
| 3 | Quality Check | 1 | Surgical find/replace fixes (uses structured schema) |
| 4 | URL Verify | 0-2 | Validate/replace dead URLs (uses structured schema) |
| 5 | Internal Links | 1 | Embed internal links from sitemap (uses structured schema) |

## Quick Start

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Set Environment Variables

```bash
export GEMINI_API_KEY=your-gemini-api-key
```

Or create a `.env` file:
```
GEMINI_API_KEY=your-gemini-api-key
```

### 3. Run the Pipeline (CLI)

```bash
# Basic usage
python run_pipeline.py --url https://example.com --keywords "keyword 1" "keyword 2" --output results/

# With all export formats
python run_pipeline.py --url https://example.com --keywords "topic" \
    --output results/ --export-formats html markdown json csv xlsx pdf

# Skip images, limit parallelism
python run_pipeline.py --url https://example.com --keywords "topic" \
    --output results/ --skip-images --max-parallel 2
```

### 4. Run the API Server

```bash
# Start the FastAPI server
uvicorn api:app --reload --port 8000

# Or run directly
python api.py
```

**API Documentation:**
- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc
- OpenAPI JSON: http://localhost:8000/openapi.json (at runtime); **`openapi.json` is also committed at the repo root** for GitHub-based imports (e.g. Floom) that expect a spec in the repository.

## REST API

The API provides async job-based processing for blog generation.

### Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Health check |
| `GET` | `/health` | Health check (alias) |
| `POST` | `/api/v1/jobs` | Start a new pipeline job (async) |
| `GET` | `/api/v1/jobs` | List all jobs |
| `GET` | `/api/v1/jobs/{job_id}` | Get job status and result |
| `DELETE` | `/api/v1/jobs/{job_id}` | Delete a job |
| `GET` | `/api/v1/jobs/{job_id}/articles` | List articles for a job |
| `GET` | `/api/v1/jobs/{job_id}/articles/{keyword}/html` | Get article HTML |
| `POST` | `/api/v1/generate` | Generate articles (sync, max 3) |

### Example: Create a Job

```bash
curl -X POST http://localhost:8000/api/v1/jobs \
  -H "Content-Type: application/json" \
  -d '{
    "keywords": ["AI in healthcare", "Machine learning basics"],
    "company_url": "https://example.com",
    "language": "en",
    "market": "US",
    "skip_images": false,
    "export_formats": ["html", "json"]
  }'
```

Response:
```json
{
  "job_id": "550e8400-e29b-41d4-a716-446655440000",
  "status": "pending",
  "message": "Job created. Processing 2 article(s).",
  "created_at": "2024-01-15T10:30:00Z"
}
```

### Example: Check Job Status

```bash
curl http://localhost:8000/api/v1/jobs/550e8400-e29b-41d4-a716-446655440000
```

## Command Line Options

```
--url               Company website URL (required)
--keywords          List of keywords to generate articles for (required)
--output            Output directory for generated files
--export-formats    Formats to export (html, markdown, json, csv, xlsx, pdf)
--skip-images       Skip image generation
--max-parallel      Maximum parallel article processing (default: 3)
--language          Content language (default: en)
--market            Target market (default: US)
--word-count        Target word count per article (default: 2000)
```

## Project Structure

```
openblog-neo/
├── shared/                 # Shared components
│   ├── gemini_client.py    # Unified Gemini client
│   ├── models.py           # ArticleOutput schema (40+ fields)
│   ├── html_renderer.py    # Render article to HTML
│   ├── article_exporter.py # Export to multiple formats
│   └── constants.py        # Model configuration
├── stage1/                 # Set Context (company, authors, sitemap)
├── stage2/                 # Blog Gen + Images
├── stage3/                 # Quality Check
├── stage4/                 # URL Verify
├── stage5/                 # Internal Links
├── run_pipeline.py         # Main orchestrator
└── requirements.txt
```

## Output Schema

Each article includes 40+ fields:

- **Headlines**: Headline, Subtitle, Teaser, Meta Title, Meta Description
- **Content**: Intro, 4-9 sections with HTML content
- **SEO**: Direct Answer (featured snippets), Key Takeaways
- **Q&A**: 4 People Also Ask, 5-6 FAQs
- **Media**: 3 image slots with URLs, alt text, credits
- **Sources**: Verified URLs from Google Search grounding
- **Optional**: Tables, Pros/Cons, CTA, Related Keywords, Video embed

## License

MIT
