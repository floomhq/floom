# Stage Refresh: Content Freshener

Uses deep research (Gemini + Google Search) to find and replace factually outdated information with verified current data.

## Purpose

Replace VERIFIED outdated facts with current data:

1. **Outdated Statistics** - Numbers with newer published data
2. **Deprecated Products** - Products officially discontinued or renamed
3. **Changed Facts** - Information that was true but is now incorrect

## What It Does NOT Do

- Does NOT remove dates to "future-proof" content
- Does NOT generalize specific references
- Does NOT make speculative updates
- Does NOT change content without a verified source

## AI Calls

- **1x Gemini**: Research with Google Search grounding
- **0x** if stage is disabled or no updates found

## Files

| File | Purpose |
|------|---------|
| `stage_refresh.py` | ContentRefresher class, CLI |
| `refresh_models.py` | RefreshInput, RefreshOutput schemas |
| `prompts/content_refresh.txt` | Prompt template |

## Input Schema (RefreshInput)

```json
{
  "article": { /* Any JSON content to refresh */ },
  "enabled": true
}
```

## Output Schema (RefreshOutput)

```json
{
  "article": { /* Content with updates applied */ },
  "fixes_applied": 1,
  "fixes": [
    {
      "field": "section_02_content",
      "find": "market size is $50 billion (2023)",
      "replace": "market size is $62 billion (2024)",
      "reason": "Per Statista Q3 2024 report"
    }
  ],
  "ai_calls": 1,
  "skipped": false
}
```

## Usage

```python
from stage_refresh import run_refresh

# Async
result = await run_refresh({"article": article_dict})

# Sync
from stage_refresh import run_refresh_sync
result = run_refresh_sync({"article": article_dict})
```

## CLI

```bash
# Basic
python stage_refresh.py --input article.json --output refreshed.json

# With timeout
python stage_refresh.py -i article.json -o refreshed.json --timeout 240

# Debug
python stage_refresh.py -i article.json --verbose

# Skip (passthrough)
python stage_refresh.py -i article.json -o out.json --disabled
```

## Example Updates

| Find | Replace | Reason |
|------|---------|--------|
| "Twitter" | "X (formerly Twitter)" | Official rebrand |
| "market is $50B (2023)" | "market is $62B (2024)" | Per Statista 2024 |

## Integration

Standalone - works with any JSON input:

```
Any Article JSON → Stage Refresh → Updated JSON
```
