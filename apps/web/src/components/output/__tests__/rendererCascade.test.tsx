/**
 * Renderer cascade unit tests (Issue #470). Run: pnpm --filter @floom/web test
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ActionSpec, NormalizedManifest } from '../../../lib/types';
import { OUTPUT_LIBRARY, pickRenderer } from '../rendererCascade';
import { renderToStaticMarkup } from 'react-dom/server';
import { RowTable } from '../RowTable';
import { ScoredRowsTable } from '../ScoredRowsTable';
import React from 'react';

function mkManifest(opts: {
  outputs: ActionSpec['outputs'];
  render?: NonNullable<NormalizedManifest['render']>;
}): NormalizedManifest {
  return {
    name: 'Test App',
    description: 't',
    actions: {
      go: {
        label: 'Go',
        inputs: [],
        outputs: opts.outputs,
      },
    },
    runtime: 'python',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '2.0',
    ...(opts.render ? { render: opts.render } : {}),
  };
}

test('competitor-style output: table + summary + model → RowTable then Markdown, model not promoted alone', () => {
  const app = {
    slug: 'competitor-analyzer',
    manifest: mkManifest({
      outputs: [
        { name: 'competitors', label: 'Competitor Table', type: 'table' },
        { name: 'summary', label: 'Comparative Summary', type: 'markdown' },
        { name: 'model', label: 'Model', type: 'text' },
      ],
    }),
  };
  const out = {
    competitors: [{ name: 'Linear', pricing: '$8/seat' }, { name: 'Notion' }],
    summary: 'Linear is faster...',
    model: 'gemini-2.5-pro',
  };
  const result = pickRenderer({ app, action: 'go', runOutput: out, runId: 'r1' });
  assert.equal(result.kind, 'auto');
  assert.equal(result.element?.props?.className, 'floom-auto-composite-output');
  const children = result.element?.props?.children;
  const rowTable = Array.isArray(children) ? children[0] : null;
  const wrap = Array.isArray(children) ? children[1] : null;
  assert.equal(rowTable?.type, OUTPUT_LIBRARY.RowTable);
  assert.equal(rowTable?.props?.rows.length, 2);
  assert.equal(rowTable?.props?.appSlug, 'competitor-analyzer');
  assert.equal(rowTable?.props?.runId, 'r1');
  assert.equal(wrap?.props?.style?.marginTop, 16);
  assert.equal(wrap?.props?.children?.props?.content, 'Linear is faster...');
});

test('rows_field hint prefers that table when multiple json/table outputs exist', () => {
  const app = {
    slug: 'x',
    manifest: mkManifest({
      render: { rows_field: 'rows' },
      outputs: [
        { name: 'items', label: 'Items', type: 'json' },
        { name: 'rows', label: 'Rows', type: 'table' },
        { name: 'summary', label: 'Summary', type: 'text' },
      ],
    }),
  };
  const out = {
    items: [{ n: 1 }, { n: 2 }],
    rows: [{ a: 'one' }],
    summary: 'Narrative.',
  };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  assert.equal(result.kind, 'auto');
  const children = result.element?.props?.children;
  const rowTable = Array.isArray(children) ? children[0] : null;
  assert.equal(rowTable?.type, OUTPUT_LIBRARY.RowTable);
  assert.equal(rowTable?.props?.rows.length, 1);
  assert.equal(rowTable?.props?.rows[0].a, 'one');
});

test('RowTable renders string[] cells as a bullet list (not stringified JSON)', () => {
  // Competitor-analyzer / resume-screener regression: fields like
  // `strengths`, `weaknesses`, `source_citations`, `gaps` are string[],
  // and used to render as `["Exceptional performance with...` with visible
  // brackets and trailing ellipsis. They now render as <ul><li>…</li></ul>.
  const rows = [
    {
      company: 'Linear',
      strengths: [
        'Exceptional performance with instant navigation',
        'Opinionated project management model',
        'Tight keyboard shortcuts and power-user UX',
      ],
      weaknesses: ['Limited reporting for managers'],
    },
  ];
  const html = renderToStaticMarkup(
    React.createElement(RowTable, { rows, appSlug: 'competitor-analyzer', runId: 'r1' }),
  );
  // Bullets rendered as <ul><li>…
  assert.ok(
    /<ul[^>]*>\s*<li/.test(html),
    'string[] cells should render a <ul><li> bullet list',
  );
  assert.ok(
    html.includes('Exceptional performance with instant navigation'),
    'bullet items should contain the raw string',
  );
  // No visible JSON brackets or trailing ellipsis from the old renderer.
  assert.ok(
    !html.includes('[&quot;Exceptional'),
    'cells should not stringify string[] into JSON-with-quotes',
  );
  assert.ok(
    !html.includes('Exceptional performance with instant navigation&quot;,&quot;'),
    'cells should not leave a comma-separated JSON blob in the table cell',
  );
});

test('ScoredRowsTable model chip: cache_hit=true appends "· CACHED" suffix', () => {
  // Phase B (#533) ships pre-generated Pro responses for demo sample inputs.
  // The chip must read e.g. "gemini-3.1-pro-preview · CACHED" so viewers
  // don't read it as live Pro inference (Floom defaults to Flash).
  const rows = [{ company: 'Acme', score: 80, reasoning: 'Strong fit' }];
  const cachedHtml = renderToStaticMarkup(
    React.createElement(ScoredRowsTable, {
      rows,
      runOutput: {
        total: 1,
        scored: 1,
        failed: 0,
        cache_hit: true,
        model: 'gemini-3.1-pro-preview',
      },
    }),
  );
  assert.ok(
    cachedHtml.includes('gemini-3.1-pro-preview'),
    'cached chip should still show the underlying model name',
  );
  assert.ok(
    cachedHtml.includes('· CACHED'),
    'cached chip should append the "· CACHED" suffix',
  );

  const liveHtml = renderToStaticMarkup(
    React.createElement(ScoredRowsTable, {
      rows,
      runOutput: {
        total: 1,
        scored: 1,
        failed: 0,
        cache_hit: false,
        model: 'gemini-3-flash-preview',
      },
    }),
  );
  assert.ok(
    liveHtml.includes('gemini-3-flash-preview'),
    'live chip should show the live model name',
  );
  assert.ok(
    !liveHtml.includes('· CACHED'),
    'live chip must NOT show the cached suffix',
  );
});

test('composite auto-pick model chip: surfaces meta.model and · CACHED for competitor-analyzer', () => {
  // Issue #579: competitor-analyzer falls into Layer 3a composite
  // (RowTable + Markdown sidecar) instead of ScoredRowsTable. Its model
  // lives at `meta.model` and cache flag at `meta.cache_hit`. The
  // composite renderer appends a ModelChip whenever meta.model is
  // present, and suffixes "· CACHED" at opacity 0.65 when cache_hit.
  const app = {
    slug: 'competitor-analyzer',
    manifest: mkManifest({
      outputs: [
        { name: 'competitors', label: 'Competitors', type: 'table' },
        { name: 'summary', label: 'Summary', type: 'markdown' },
      ],
    }),
  };
  const cachedOut = {
    competitors: [{ name: 'Linear', pricing: '$8/seat' }],
    summary: 'Linear is faster...',
    meta: {
      analyzed: 1,
      failed: 0,
      cache_hit: true,
      model: 'gemini-3.1-pro-preview',
    },
  };
  const cached = pickRenderer({ app, action: 'go', runOutput: cachedOut, runId: 'r1' });
  assert.equal(cached.kind, 'auto');
  const cachedHtml = renderToStaticMarkup(cached.element!);
  assert.ok(cachedHtml.includes('gemini-3.1-pro-preview'), 'model name should render');
  assert.ok(cachedHtml.includes('· CACHED'), 'cache_hit=true should append "· CACHED"');
  assert.ok(/opacity:\s*0\.65/.test(cachedHtml), 'cached suffix should be dimmed to 0.65 opacity');

  const liveOut = {
    ...cachedOut,
    meta: { ...cachedOut.meta, cache_hit: false },
  };
  const live = pickRenderer({ app, action: 'go', runOutput: liveOut, runId: 'r2' });
  const liveHtml = renderToStaticMarkup(live.element!);
  assert.ok(liveHtml.includes('gemini-3.1-pro-preview'), 'live model name should render');
  assert.ok(!liveHtml.includes('· CACHED'), 'cache_hit=false must NOT append "· CACHED"');

  // Legacy fixtures stamp "(cached)" into the model string itself; the
  // chip strips it before re-appending its own suffix (mirrors the
  // ScoredRowsTable normalization in PR #578).
  const doubleOut = {
    ...cachedOut,
    meta: { ...cachedOut.meta, cache_hit: true, model: 'gemini-3.1-pro-preview (cached)' },
  };
  const doubled = pickRenderer({ app, action: 'go', runOutput: doubleOut, runId: 'r3' });
  const doubledHtml = renderToStaticMarkup(doubled.element!);
  assert.ok(!/\(cached\)/i.test(doubledHtml), 'legacy "(cached)" should be stripped');
  assert.ok(doubledHtml.includes('· CACHED'), 'the new suffix should be present');
});

test('composite auto-pick model chip: absent when meta.model is missing', () => {
  // Any app that returns {rows, summary} without a meta.model must not
  // sprout a chip. Keeps the zero-config "just shape-based" path quiet
  // for non-AI apps (e.g. plain CSV aggregators).
  const app = {
    slug: 'plain-table-app',
    manifest: mkManifest({
      outputs: [
        { name: 'rows', label: 'Rows', type: 'table' },
        { name: 'summary', label: 'Summary', type: 'markdown' },
      ],
    }),
  };
  const out = {
    rows: [{ a: 1, b: 2 }],
    summary: 'Narrative.',
  };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  const html = renderToStaticMarkup(result.element!);
  assert.ok(!html.includes('composite-model-chip'), 'no chip when meta.model missing');
  assert.ok(!html.includes('· CACHED'), 'no cache suffix without model');
});

test('CompetitorTiles: positioning + strengths/weaknesses shape → dedicated tile renderer', () => {
  // #643 slap polish: when the competitor-analyzer output carries the
  // full positioning + strengths[] + weaknesses[] shape, pickRenderer
  // should short-circuit to CompetitorTiles rather than the cramped
  // RowTable+Markdown composite. Legacy thin payloads (no positioning,
  // no strengths, no weaknesses) continue to fall through to the
  // composite path — covered by the first test in this file.
  const app = {
    slug: 'competitor-analyzer',
    manifest: mkManifest({
      outputs: [
        { name: 'competitors', label: 'Competitors', type: 'table' },
        { name: 'summary', label: 'Summary', type: 'markdown' },
      ],
    }),
  };
  const out = {
    competitors: [
      {
        url: 'https://linear.app',
        company: 'Linear',
        positioning: 'Product development system for teams and agents.',
        pricing: '$10/user/mo',
        strengths: ['Keyboard-centric UI', 'Deep GitHub integration'],
        weaknesses: ['No CRM features', 'Rigid per-seat pricing'],
      },
    ],
    summary: 'Linear is fast but has no GTM features.',
    meta: { model: 'gemini-3.1-pro-preview', cache_hit: false },
  };
  const result = pickRenderer({ app, action: 'go', runOutput: out, runId: 'r9' });
  assert.equal(result.kind, 'library');
  const html = renderToStaticMarkup(result.element!);
  assert.ok(html.includes('data-renderer="CompetitorTiles"'), 'CompetitorTiles should render');
  assert.ok(html.includes('Linear'), 'company name should render');
  assert.ok(html.includes('Strengths'), 'Strengths column label should render');
  assert.ok(html.includes('Gaps vs you'), 'Weaknesses column label should render');
  assert.ok(html.includes('Keyboard-centric UI'), 'strength bullet should render');
  assert.ok(html.includes('No CRM features'), 'weakness bullet should render');
});

test('CompetitorTiles: thin payload without positioning/strengths/weaknesses falls through to composite', () => {
  // Guard against accidentally hijacking unrelated "competitors"-named
  // arrays. The first test in this file already asserts the composite
  // path for the thin case; this one asserts the shape-check returns
  // false when none of the three identifying fields are present.
  const app = {
    slug: 'competitor-analyzer',
    manifest: mkManifest({
      outputs: [
        { name: 'competitors', label: 'Competitors', type: 'table' },
      ],
    }),
  };
  const out = {
    competitors: [{ name: 'Linear', pricing: '$10/user/mo' }],
  };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  assert.equal(result.kind, 'auto');
  const html = renderToStaticMarkup(result.element!);
  assert.ok(!html.includes('data-renderer="CompetitorTiles"'), 'CompetitorTiles should NOT render for thin payload');
});

test('ScoredRowsTable: top row gets hero + display score + gold highlight', () => {
  // #643 slap polish: the top-scored row gets a #1 hero block with a
  // big display serif number and a gold-tinted highlight bar. Rows 2+
  // render in the table without the highlight.
  const rows = [
    { company: 'Stripe', score: 92, reasoning: 'Enterprise fit. EU presence. Scaled API.' },
    { company: 'Acme', score: 65, reasoning: 'Mid-market only.' },
  ];
  const html = renderToStaticMarkup(
    React.createElement(ScoredRowsTable, {
      rows,
      runOutput: { total: 2, scored: 2, failed: 0, model: 'gemini-3.1-pro-preview' },
      appSlug: 'lead-scorer',
    }),
  );
  assert.ok(html.includes('scored-rows-hero'), 'hero block should render');
  assert.ok(html.includes('Stripe'), 'top company should appear in hero');
  assert.ok(html.includes('92/100') || html.includes('92'), 'score text should appear');
  assert.ok(html.includes('Strong fit'), 'tier label should render');
  assert.ok(html.includes('data-top="true"'), 'top row should carry data-top attribute');
  // Bullet split: "Enterprise fit. EU presence. Scaled API." → 3 bullets
  assert.ok(html.includes('scored-rows-bullets-0'), 'bullets should render for prose reason');
});

test('ScoredRowsTable model chip: legacy "(cached)" backend stamp is normalized, not doubled', () => {
  // examples/lead-scorer/main.py uses setdefault("model", "...-pro-preview (cached)")
  // as a fallback when the cache fixture lacks a `model` field. The UI must
  // strip that suffix before re-appending its own "· CACHED" marker so we
  // don't end up with "...-pro-preview (cached) · CACHED".
  const rows = [{ company: 'Acme', score: 80 }];
  const html = renderToStaticMarkup(
    React.createElement(ScoredRowsTable, {
      rows,
      runOutput: {
        cache_hit: true,
        model: 'gemini-3.1-pro-preview (cached)',
      },
    }),
  );
  assert.ok(
    !/\(cached\)/i.test(html),
    'the legacy "(cached)" suffix should be stripped from the chip text',
  );
  assert.ok(html.includes('· CACHED'), 'the new suffix should be present exactly once');
});
