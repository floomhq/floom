# pd2-02 — Competitive framing (honest positioning)

**Lens:** PRODUCT “hosting is the product” vs “OpenAPI wrapping” advanced path · ROADMAP P0 repo-hosted gap · cross `pd-01`, `pd-04`, `pd-19`.

## Executive truth table

| # | Claim implied by PRODUCT | Market interpretation | Verdict |
|---|---------------------------|------------------------|---------|
| 1 | “Paste repo → production in 30 seconds” | Competes with PaaS / Vercel-style flows | **Partial** until repo route + `/build` ramp land (ROADMAP) |
| 2 | Three surfaces (web, MCP, HTTP) | “Headless gateway” competitors | **Met** on architecture; **Partial** on messaging (MCP can read as dev-only) |
| 3 | Non-dev ICP | Positioning often drifts to OpenAPI / spec language in-product | **Partial** (`pd-04`) |
| 4 | Self-host same image as cloud | Honest for operators; ICP may never see it | **Met** / **N/A** for pure cloud ICP |
| 5 | Custom renderer + async as differentiators | True if UI and story are visible; else “backend feature” | **Partial** (ROADMAP UI in flight) |

## ICP failure tree

1. **Landing emphasizes spec/OpenAPI**  
   - *Breaks:* mental model = “I need an API” not “I have a repo”.  
   - *Sees:* wrong ramp.  
   - *Recovery:* only if repo path is equally visible (`pd-02`, `pd-19`).

2. **ICP compares to Zapier/Make**  
   - *Breaks:* no “automation grid” metaphor.  
   - *Sees:* developer gateway.  
   - *Recovery:* outcome copy + one screenshot of `/p/:slug` for a real app.

3. **ICP compares to ChatGPT plugins**  
   - *Breaks:* MCP named without “why you care”.  
   - *Sees:* acronym soup.  
   - *Recovery:* one line: “Use from Cursor / Claude / any MCP client.”

## Risk register

| ID | Sev | Risk |
|----|-----|------|
| C1 | P1 | **Positioning–reality gap** on repo-hosted weakens trust harder than missing a small UI tweak |
| C2 | P2 | MCP-first story **shrinks** perceived ICP to developers |
| C3 | P2 | “Advanced path” OpenAPI **overshadows** primary path in nav or SEO snippets |

## PM questions

1. One homepage **primary** CTA: repo URL, OpenAPI URL, or “try a demo app”?  
2. Do you want **explicit** “Not for Docker experts” vs silence on Docker? (PRODUCT already says users never install tooling.)  
3. Is **MCP** named on the landing hero, or deferred to a secondary “For agents” block?
