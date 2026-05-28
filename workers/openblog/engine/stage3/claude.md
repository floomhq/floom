# Stage 3: Quality Check

Surgical fixes to transform AI-generated content into human-written copywriter quality.

## Purpose

Make blog content sound like it was written by a professional human copywriter:

1. **Remove AI Filler Phrases** - "In today's rapidly evolving...", "Let's dive into..."
2. **Fix Em-dashes** - Replace (—) with regular dash (-) or comma
3. **Strengthen Weak Openings** - Make sentences more direct
4. **Tone Down Promotional Fluff** - "revolutionary" → specific benefits
5. **Vary Sentence Structure** - Fix repetitive patterns
6. **Remove Duplicate FAQ/PAA** - Deduplicate questions
7. **Fix Stilted Language** - "utilize" → "use", "leverage" → "use"

## AI Calls

- **1x Gemini**: Quality review with structured JSON schema (no grounding needed)
- **0x** if stage is disabled

Uses `generate_with_schema()` for typed response validation.

## Files

| File | Purpose |
|------|---------|
| `stage_3.py` | QualityFixer class, main orchestrator, CLI |
| `stage3_models.py` | Stage3Input, Stage3Output, QualityFix schemas |
| `prompts/quality_check.txt` | Quality check prompt template |
| `__init__.py` | Package exports |

## Input Schema (Stage3Input)

```json
{
  "article": { /* ArticleOutput dict from Stage 2 */ },
  "keyword": "sales automation",
  "language": "en",
  "enabled": true
}
```

## Output Schema (Stage3Output)

```json
{
  "article": { /* ArticleOutput with fixes applied */ },
  "fixes_applied": 5,
  "fixes": [
    {
      "field": "section_01_content",
      "find": "In today's rapidly evolving digital landscape,",
      "replace": "",
      "reason": "AI filler phrase removed"
    }
  ],
  "ai_calls": 1,
  "skipped": false
}
```

## Usage

```python
from stage_3 import QualityFixer, run_stage_3

# Quick function (async)
result = await run_stage_3({
    "article": article_dict,
    "keyword": "sales automation",
    "language": "en"
})

# Sync wrapper
from stage_3 import run_stage_3_sync
result = run_stage_3_sync({...})

# Class-based
fixer = QualityFixer()
output = await fixer.run(Stage3Input(...))
```

## CLI

```bash
# Basic usage
python stage_3.py --input stage2_output.json --output stage3_output.json

# With options
python stage_3.py -i input.json -o output.json --keyword "sales automation" --language en

# Custom timeout (default: 120s)
python stage_3.py -i input.json -o output.json --timeout 60

# Debug logging
python stage_3.py -i input.json -o output.json --verbose

# Skip quality check (passthrough)
python stage_3.py -i input.json -o output.json --disabled
```

## Surgical Fix Examples

| Find | Replace | Reason |
|------|---------|--------|
| "In today's rapidly evolving..." | "" | AI filler phrase |
| "game-changing" | "effective" | Promotional fluff |
| "the tool—which is powerful—works" | "the tool, which is powerful, works" | Em-dash cleanup |
| "utilize" | "use" | Stilted language |
| "It's important to note that" | "" | Weak sentence starter |
| "leverage" | "use" | Corporate jargon |

## Integration

Stage 3 receives ArticleOutput from Stage 2 and passes it to Stage 4:

```
Stage 2 (Blog Gen) → Stage 3 (Quality) → Stage 4 (URLs) → Stage 5 (Links)
```
