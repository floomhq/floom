#!/usr/bin/env node
// v16 renderer cascade tests.
//
// Exercises pickRenderer + autoPick from
// apps/web/src/components/output/rendererCascade.tsx. Runs under tsx so
// the TSX file can import its sibling components without a build step.
//
// Coverage:
//   - Layer 2: manifest-declared output_component → right library mount
//   - Layer 2 miss (typo in component name) → falls through to Layer 3
//   - Layer 2 miss (missing *_field reference) → falls through to Layer 3
//   - Layer 3: auto-pick html → FileDownload
//   - Layer 3: auto-pick markdown/summary/report → Markdown
//   - Layer 3: short string → TextBig
//   - Layer 3: code-like string with language hint → CodeBlock
//   - Layer 4: no match → kind:'fallback', element:null
//
// The test avoids mounting a full React tree; it checks component
// identity via the element's `type` pointer (react element shape).

import { pickRenderer, OUTPUT_LIBRARY, __test__ } from '../../apps/web/src/components/output/rendererCascade.tsx';

let passed = 0;
let failed = 0;

function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

function mkManifest(opts) {
  return {
    name: 'Test App',
    description: 't',
    actions: {
      go: {
        label: 'Go',
        inputs: [],
        outputs: opts.outputs ?? [],
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

console.log('v16 renderer cascade tests');

// ---------- Layer 2: manifest-declared component ----------

{
  const app = {
    manifest: mkManifest({
      render: { output_component: 'TextBig', value_field: 'uuids', copyable: true },
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = { uuids: ['abc-123'], version: 'v4', count: 1 };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Layer 2: TextBig picked by output_component', result.kind === 'library');
  log('Layer 2: TextBig component identity matches', result.element?.type === OUTPUT_LIBRARY.TextBig);
  log('Layer 2: value_field plucked first array entry', result.element?.props.value === 'abc-123');
  log('Layer 2: copyable prop passed through', result.element?.props.copyable === true);
}

{
  const app = {
    manifest: mkManifest({
      render: { output_component: 'CodeBlock', code_field: 'formatted', language: 'json' },
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = { formatted: '{\n  "a": 1\n}', minified: '{"a":1}' };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Layer 2: CodeBlock picked', result.kind === 'library');
  log('Layer 2: CodeBlock code prop populated', result.element?.props.code === '{\n  "a": 1\n}');
  log('Layer 2: CodeBlock language prop preserved', result.element?.props.language === 'json');
}

{
  const app = {
    manifest: mkManifest({
      render: {
        output_component: 'FileDownload',
        bytes_field: 'pdf_base64',
        filename: 'slides.pdf',
        mime: 'application/pdf',
        previewHtml_field: 'preview',
      },
      outputs: [],
    }),
  };
  const out = {
    pdf_base64: 'JVBERi0xLjQK',
    preview: '<h1>slide 1</h1>',
  };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Layer 2: FileDownload picked', result.kind === 'library');
  log('Layer 2: bytes plucked', result.element?.props.bytes === 'JVBERi0xLjQK');
  log('Layer 2: filename passed through', result.element?.props.filename === 'slides.pdf');
  log('Layer 2: previewHtml_field plucked', result.element?.props.previewHtml === '<h1>slide 1</h1>');
}

{
  const app = {
    slug: 'lead-scorer',
    manifest: mkManifest({
      render: {
        output_component: 'ScoredRowsTable',
        rows_field: 'rows',
        company_key: 'company',
        reason_key: 'reasoning',
        source_key: 'website',
        score_scale: '0-100',
      },
      outputs: [{ name: 'rows', label: 'Scored Leads', type: 'table' }],
    }),
  };
  const out = {
    total: 2,
    scored: 2,
    failed: 0,
    model: 'gemini-3.1-pro-preview',
    rows: [
      { company: 'Acme', website: 'https://example.com', score: 91, reasoning: 'Strong fit' },
      { company: 'Globex', website: 'https://globex.test', score: 42, reasoning: 'Mixed fit' },
    ],
  };
  const result = pickRenderer({ app, action: 'go', runOutput: out, runId: 'run_demo' });
  log('Layer 2: ScoredRowsTable picked', result.kind === 'library');
  log(
    'Layer 2: ScoredRowsTable component identity matches',
    result.element?.type === OUTPUT_LIBRARY.ScoredRowsTable,
  );
  log('Layer 2: ScoredRowsTable gets rows array', result.element?.props.rows.length === 2);
  log('Layer 2: ScoredRowsTable gets full run output', result.element?.props.runOutput?.total === 2);
  log('Layer 2: ScoredRowsTable gets appSlug/runId', result.element?.props.appSlug === 'lead-scorer' && result.element?.props.runId === 'run_demo');
}

// ---------- Layer 2 miss: typo in component name falls through ----------

{
  const app = {
    manifest: mkManifest({
      render: { output_component: 'TextBigg', value_field: 'x' },
      outputs: [{ name: 'summary', label: 'Summary', type: 'markdown' }],
    }),
  };
  const out = { summary: 'Important finding.', x: 'ignored' };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Typo in output_component falls through to auto-pick', result.kind === 'auto');
  log('Fall-through picks Markdown for summary field', result.element?.type === OUTPUT_LIBRARY.Markdown);
}

// ---------- Layer 2 miss: missing *_field reference falls through ----------

{
  const app = {
    manifest: mkManifest({
      render: { output_component: 'TextBig', value_field: 'missing' },
      outputs: [{ name: 'summary', label: 'Summary', type: 'markdown' }],
    }),
  };
  const out = { summary: 'Fallback content.' };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Missing *_field falls through (no render error)', result.kind === 'auto');
  log('Markdown content plucked by auto-pick', result.element?.props.content === 'Fallback content.');
}

// ---------- Layer 3: auto-pick heuristics ----------

{
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'preview', label: 'Preview', type: 'html' }],
    }),
  };
  const out = { preview: '<h1>Hello</h1>' };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Auto-pick: html type → FileDownload', result.element?.type === OUTPUT_LIBRARY.FileDownload);
  log('Auto-pick: previewHtml set from html field', result.element?.props.previewHtml === '<h1>Hello</h1>');
}

{
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'report', label: 'Report', type: 'markdown' }],
    }),
  };
  const out = { report: '# Findings\n\nSome text.' };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Auto-pick: report field → Markdown', result.element?.type === OUTPUT_LIBRARY.Markdown);
}

{
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'answer', label: 'Answer', type: 'text' }],
    }),
  };
  const out = { answer: '42' };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Auto-pick: single short string → TextBig', result.element?.type === OUTPUT_LIBRARY.TextBig);
  log('Auto-pick: TextBig value plucked', result.element?.props.value === '42');
}

{
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'payload', label: 'Payload', type: 'text' }],
    }),
  };
  const out = { payload: '{"a":1,"b":[2,3,4]}' };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Auto-pick: json-ish string → CodeBlock', result.element?.type === OUTPUT_LIBRARY.CodeBlock);
  log('Auto-pick: CodeBlock language inferred', result.element?.props.language === 'json');
}

// ---------- Layer 4: genuine fallback ----------

{
  // Truly heterogeneous nested shape: one outer key → one inner object →
  // one deeply-nested object. None of the shape heuristics have enough
  // signal to render this as something other than a JSON dump, so the
  // cascade falls through and OutputPanel renders JsonRaw.
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = { response: { nested: { shape: true } } };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('No match → kind=fallback, element=null', result.kind === 'fallback' && result.element === null);
}

// ---------- Layer 3b: runtime-shape heuristics ---------------------
//
// Added 2026-04-20. Covers the common OpenAPI-ingested app outputs
// (uuid, password, jwt-decode, word-count, base64) which all declare a
// single generic `json` output and therefore bypass the schema-driven
// Layer 3a auto-pick.

{
  // uuid: {version, count, uuids: [...]}. The uuids array has 3+ items,
  // but the headline pattern doesn't match (no password / result /
  // answer field). Should fall to KeyValueTable, not raw JSON.
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = { version: 'v4', count: 3, uuids: ['a-1', 'a-2', 'a-3'] };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Shape: uuid-shaped output → kind=shape', result.kind === 'shape');
  log('Shape: uuid output renders as KeyValueTable', result.element?.type === OUTPUT_LIBRARY.KeyValueTable);
}

{
  // Single-key unwrap: {uuids: ['...']} alone → StringList on the array.
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = { uuids: ['a-1', 'a-2'] };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Shape: {uuids: [...]} unwraps to StringList', result.element?.type === OUTPUT_LIBRARY.StringList);
}

{
  // password: {password, length, alphabet_size, entropy_bits}. Password
  // is the headline, the three numerics are meta chips.
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = {
    password: 'Xk9!mP2qRvL4',
    length: 12,
    alphabet_size: 94,
    entropy_bits: 78.7,
  };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Shape: password output → HeadlineWithMeta', result.element?.type === OUTPUT_LIBRARY.HeadlineWithMeta);
  log('Shape: password headline plucked', result.element?.props.headline === 'Xk9!mP2qRvL4');
  log('Shape: password has 3 meta chips', result.element?.props.meta.length === 3);
}

{
  // base64 decode: {mode: 'decode', url_safe: false, result: 'hello',
  // result_length: 5}. `result` is the headline, the rest are chips.
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = {
    mode: 'decode',
    url_safe: false,
    result: 'hello world',
    result_length: 11,
  };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Shape: base64 decode → HeadlineWithMeta', result.element?.type === OUTPUT_LIBRARY.HeadlineWithMeta);
  log('Shape: base64 headline is the decoded text', result.element?.props.headline === 'hello world');
}

{
  // jwt-decode: {header: {...}, payload: {...}, ...}. Multiple nested
  // fields, no headline field → KeyValueTable.
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = {
    header: { alg: 'HS256', typ: 'JWT' },
    payload: { sub: '123', name: 'Jane' },
    signature: 'abc',
    algorithm: 'HS256',
    verified: false,
  };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Shape: jwt-decode → KeyValueTable', result.element?.type === OUTPUT_LIBRARY.KeyValueTable);
  log('Shape: jwt-decode has all entries', result.element?.props.entries.length === 5);
}

{
  // word-count: {words, chars, chars_no_spaces, lines, sentences, paragraphs,
  // reading_time_minutes}. All numeric, no headline. → KeyValueTable.
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = {
    words: 42,
    chars: 210,
    chars_no_spaces: 175,
    lines: 3,
    sentences: 4,
    paragraphs: 1,
    reading_time_minutes: 1,
  };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Shape: word-count → KeyValueTable', result.element?.type === OUTPUT_LIBRARY.KeyValueTable);
}

{
  // Single URL field → UrlLink.
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = { url: 'https://example.com/foo' };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Shape: single URL → UrlLink', result.element?.type === OUTPUT_LIBRARY.UrlLink);
}

{
  // Single image (data URL) → ImageView.
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = {
    image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Shape: image data URL → ImageView', result.element?.type === OUTPUT_LIBRARY.ImageView);
}

{
  // Array of flat objects at the top level → RowTable.
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = [
    { name: 'Alice', age: 30, city: 'NYC' },
    { name: 'Bob', age: 25, city: 'SF' },
  ];
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Shape: array of flat objects → RowTable', result.element?.type === OUTPUT_LIBRARY.RowTable);
  log('Shape: RowTable has all rows', result.element?.props.rows.length === 2);
}

{
  // Single scalar (number) as a one-key object → ScalarBig.
  const app = {
    manifest: mkManifest({
      outputs: [{ name: 'response', label: 'Response', type: 'json' }],
    }),
  };
  const out = { count: 42 };
  const result = pickRenderer({ app, action: 'go', runOutput: out });
  log('Shape: {count: 42} → ScalarBig', result.element?.type === OUTPUT_LIBRARY.ScalarBig);
  log('Shape: ScalarBig value is 42', result.element?.props.value === 42);
}

// ---------- resolveRenderProps edge cases ----------

{
  const resolved = __test__.resolveRenderProps(
    { output_component: 'X', filename: 'a.bin', extra: true, value_field: 'v' },
    { v: 'hello' },
  );
  log('resolveRenderProps: output_component stripped', resolved.output_component === undefined);
  log('resolveRenderProps: non-_field keys pass through', resolved.filename === 'a.bin' && resolved.extra === true);
  log('resolveRenderProps: _field resolved', resolved.value === 'hello');
}

{
  const resolved = __test__.resolveRenderProps(
    { value_field: 'missing' },
    { other: 'thing' },
  );
  log('resolveRenderProps: missing field → null (bail)', resolved === null);
}

{
  // items_field plucks the raw array (not a string) — used by the
  // StringList library component for uuid-style outputs where each
  // item needs to render as its own chip.
  const resolved = __test__.resolveRenderProps(
    { output_component: 'StringList', items_field: 'uuids', label: 'UUIDs' },
    { uuids: ['a', 'b', 'c'] },
  );
  log(
    'resolveRenderProps: items_field returns raw array',
    Array.isArray(resolved.items) && resolved.items.length === 3,
  );
  log('resolveRenderProps: label pass-through', resolved.label === 'UUIDs');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
