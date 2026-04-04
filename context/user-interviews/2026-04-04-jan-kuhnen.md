# Interview: Jan Kühnen

- **Date**: 2026-04-04
- **Role**: Software developer / tools builder, aerospace sector
- **Duration**: ~20min

## Background

- Builds decision support tools and ML-based automation for clients in aerospace and adjacent industries
- Creates everything as CLIs today — no hosted UI
- First natural next step he identified: HTML app with hosting (exactly what floomit is)
- Clients would pay €1k/year easily

## Current Stack

- All tooling built as CLIs
- ML algorithms with large file I/O (CSV, TXT → new file format or table)
- Model layer in the middle between raw data and output
- No hosted UI / no sharing layer today

## Use Cases Discussed

### 1. Flugsichere Route
Tool that computes aviation-safe flight routes. Likely rule-based + ML, needs to connect to aerospace data systems.

### 2. FlyFast — auto + preis + flieger
Travel optimization automation. Takes car (auto), flight (flieger), and price (preis) data and computes the best option. Combines multiple data sources.

### 3. LinkedIn Campaign from Slides
Takes slides or structured content as input, generates a LinkedIn campaign. Open question: **how does he distribute/share the output?** No clean handoff today — output lands in CLI, he has to manually post.

### 4. Aerospace Data Integration
Wants to connect tools to aerospace data systems (APIs, feeds). Asked: "Can we connect to these?"

### 5. ML Decision Support Tools
His main product category. Large file inputs (CSV, TXT) → model layer → new output file or table. Each tool is a pipeline with input, processing, and output.

## Pain Points

- **No UI, no sharing**: everything is a CLI — clients can't use tools without him
- **Large file I/O**: inputs and outputs are often huge files (CSV, TXT, custom formats) — not just small structured data
- **Arbitrary output formats**: outputs aren't always tables — sometimes a new file format entirely
- **Distribution gap**: LinkedIn campaign output has no clean way to share or hand off

## Floom Fit

- Identified HTML app + hosting as his ideal next step unprompted
- The CLI → deployed UI path is exactly his job to be done
- Strong pricing signal: clients pay €1k/year easily without hesitation
- Will need large file input/output support to cover his ML use cases

## Key Insights

- **Pricing signal**: €1k/year per client — among the strongest willingness-to-pay signals so far
- **CLI builders are a real segment**: he doesn't know how to add a UI — that's the blocker, not the logic
- **File output matters**: his tools don't just return tables — they return new file formats, which floomit doesn't support yet
- **Sharing is the missing layer**: he builds the logic, but can't give it to clients without building a full app
