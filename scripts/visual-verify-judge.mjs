#!/usr/bin/env node
// Gemini-judged visual verification of captured screenshots.
//
// For each screenshot in $SHOTS_DIR/capture-manifest.json, we send one
// multi-modal request to gemini-3.1-pro-preview asking for a structured
// JSON verdict. We aggregate to a single PASS/PARTIAL/FAIL and emit a
// markdown report.
//
// Env:
//   GEMINI_API_KEY  - required, Google AI Studio key
//   COMMIT_SHA      - the commit under verification
//   COMMIT_TITLE    - latest merge commit title
//   COMMIT_BODY     - latest merge commit body
//   SHOTS_DIR       - dir containing capture-manifest.json + shots/
//   REPORT_PATH     - markdown output path
//
// Outputs:
//   $REPORT_PATH                         — markdown summary
//   $SHOTS_DIR/report.json               — structured per-route verdicts
//   GITHUB_OUTPUT verdict=PASS|PARTIAL|FAIL
//   GITHUB_OUTPUT report_path=<path>

import fs from 'node:fs';
import path from 'node:path';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const COMMIT_SHA = process.env.COMMIT_SHA || '(unknown)';
const COMMIT_TITLE = process.env.COMMIT_TITLE || '(no title)';
const COMMIT_BODY = process.env.COMMIT_BODY || '';
const SHOTS_DIR = process.env.SHOTS_DIR || path.join(process.cwd(), 'visual-verify-output');
const REPORT_PATH = process.env.REPORT_PATH || path.join(SHOTS_DIR, 'report.md');
const GEMINI_MODEL = 'gemini-3.1-pro-preview';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

if (!GEMINI_API_KEY) {
  console.error('[judge] GEMINI_API_KEY not set');
  process.exit(1);
}

const manifestPath = path.join(SHOTS_DIR, 'capture-manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`[judge] manifest not found: ${manifestPath}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

function buildPrompt(route) {
  const wireframeUrl = `https://wireframes.floom.dev/v17/${route.slug}.html`;
  return [
    `Screenshot of ${route.url} at ${route.viewport} (${route.viewport_width}x${route.viewport_height}).`,
    `Latest merge title: ${COMMIT_TITLE}`,
    `Latest merge body: ${COMMIT_BODY || '(empty)'}`,
    '',
    'Verify:',
    '1. Did the claimed change render?',
    `2. Any regressions visible (pure black backgrounds, broken layouts, console errors, loading skeletons appearing permanently, emoji where they shouldn't be)?`,
    `3. Does it match the wireframe at ${wireframeUrl} structurally? (fonts don't need to match — the wireframes typography is stale)`,
    '',
    'Output JSON only:',
    '{"verdict": "PASS|FAIL|PARTIAL", "reasoning": "...", "critical_issues": [...], "suggestions": [...]}',
  ].join('\n');
}

async function callGemini(route) {
  const filePath = path.join(SHOTS_DIR, route.file);
  if (!fs.existsSync(filePath)) {
    return {
      verdict: 'FAIL',
      reasoning: `Screenshot file missing: ${route.file}`,
      critical_issues: ['missing screenshot'],
      suggestions: [],
    };
  }

  const imageB64 = fs.readFileSync(filePath).toString('base64');
  const prompt = buildPrompt(route);

  const body = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inline_data: { mime_type: 'image/png', data: imageB64 } },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.2,
    },
  };

  // Retry twice on transient errors.
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${GEMINI_URL}?key=${encodeURIComponent(GEMINI_API_KEY)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${text.substring(0, 500)}`);
      }
      const data = await resp.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        throw new Error(`no text in response: ${JSON.stringify(data).substring(0, 500)}`);
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        // Best-effort: strip fences.
        const cleaned = text.replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
        parsed = JSON.parse(cleaned);
      }
      // Normalise.
      return {
        verdict: ['PASS', 'FAIL', 'PARTIAL'].includes(parsed.verdict) ? parsed.verdict : 'PARTIAL',
        reasoning: String(parsed.reasoning || ''),
        critical_issues: Array.isArray(parsed.critical_issues) ? parsed.critical_issues : [],
        suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
      };
    } catch (err) {
      lastErr = err;
      console.warn(`[judge] attempt ${attempt + 1} failed for ${route.slug}/${route.viewport}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return {
    verdict: 'PARTIAL',
    reasoning: `Gemini call failed after 3 attempts: ${lastErr && lastErr.message}`,
    critical_issues: ['judge call failed'],
    suggestions: ['retry workflow'],
  };
}

function aggregate(results) {
  const anyFail = results.some((r) => r.verdict === 'FAIL');
  if (anyFail) return 'FAIL';
  const anyPartial = results.some((r) => r.verdict === 'PARTIAL');
  if (anyPartial) return 'PARTIAL';
  return 'PASS';
}

function renderReport(overall, results) {
  const lines = [];
  lines.push(`# Visual verify report`);
  lines.push('');
  lines.push(`**Commit:** \`${COMMIT_SHA.substring(0, 7)}\``);
  lines.push(`**Title:** ${COMMIT_TITLE}`);
  lines.push(`**Overall verdict:** **${overall}**`);
  lines.push('');
  lines.push(`**Base URL:** ${manifest.base_url}`);
  lines.push(`**Captured:** ${manifest.captured_at}`);
  lines.push(`**Model:** ${GEMINI_MODEL}`);
  lines.push('');
  lines.push(`| Route | Viewport | Verdict | Critical issues |`);
  lines.push(`|---|---|---|---|`);
  for (const r of results) {
    const issues = r.verdict_detail.critical_issues.length
      ? r.verdict_detail.critical_issues.join('; ').replace(/\|/g, '\\|')
      : '-';
    lines.push(`| \`${r.path}\` | ${r.viewport} | ${r.verdict_detail.verdict} | ${issues} |`);
  }
  lines.push('');
  for (const r of results) {
    if (r.verdict_detail.verdict === 'PASS') continue;
    lines.push(`### \`${r.path}\` (${r.viewport}) — ${r.verdict_detail.verdict}`);
    lines.push('');
    if (r.verdict_detail.reasoning) {
      lines.push(`${r.verdict_detail.reasoning}`);
      lines.push('');
    }
    if (r.verdict_detail.critical_issues.length) {
      lines.push(`**Critical issues:**`);
      for (const issue of r.verdict_detail.critical_issues) {
        lines.push(`- ${issue}`);
      }
      lines.push('');
    }
    if (r.verdict_detail.suggestions.length) {
      lines.push(`**Suggestions:**`);
      for (const s of r.verdict_detail.suggestions) {
        lines.push(`- ${s}`);
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

async function main() {
  console.log(`[judge] routes: ${manifest.routes.length}`);
  const results = [];
  for (const route of manifest.routes) {
    console.log(`[judge] ${route.slug} ${route.viewport}`);
    const verdictDetail = await callGemini(route);
    results.push({
      slug: route.slug,
      path: route.path,
      viewport: route.viewport,
      url: route.url,
      verdict_detail: verdictDetail,
    });
  }

  const overall = aggregate(results.map((r) => r.verdict_detail));
  const report = renderReport(overall, results);

  fs.writeFileSync(REPORT_PATH, report);
  fs.writeFileSync(
    path.join(SHOTS_DIR, 'report.json'),
    JSON.stringify({ overall, commit: COMMIT_SHA, model: GEMINI_MODEL, results }, null, 2),
  );
  console.log(`[judge] overall verdict: ${overall}`);
  console.log(`[judge] wrote report: ${REPORT_PATH}`);

  const ghOut = process.env.GITHUB_OUTPUT;
  if (ghOut) {
    fs.appendFileSync(ghOut, `verdict=${overall}\n`);
    fs.appendFileSync(ghOut, `report_path=${REPORT_PATH}\n`);
  }
}

main().catch((err) => {
  console.error('[judge] fatal:', err);
  process.exit(1);
});
