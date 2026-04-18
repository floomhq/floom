#!/usr/bin/env node
// RunSurface behaviour tests (v16 one-surface shell).
//
// Exercises the pure helpers exported from
// apps/web/src/components/runner/RunSurface.tsx. The component itself is
// React-only; we verify the decision logic that drives the UI (refinable
// default, stacked opt-out, job → run adaptation, input coercion,
// timestamp formatting) without mounting a tree.
//
// Runs under tsx so the TSX import works without a build step.

import {
  __test__,
  deriveRunLabel,
  deriveSharedRunBanner,
  deriveStacked,
} from '../../apps/web/src/components/runner/RunSurface.tsx';

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

console.log('RunSurface shell tests');

// ---------- deriveRunLabel ----------
{
  log('Empty state → Run', deriveRunLabel({ hasRun: false, refinable: undefined }) === 'Run');
  log('After run, default refinable → Refine', deriveRunLabel({ hasRun: true, refinable: undefined }) === 'Refine');
  log('After run, refinable=true → Refine', deriveRunLabel({ hasRun: true, refinable: true }) === 'Refine');
  log('After run, refinable=false stays Run', deriveRunLabel({ hasRun: true, refinable: false }) === 'Run');
  log('Before run, refinable=false → Run', deriveRunLabel({ hasRun: false, refinable: false }) === 'Run');
}

// ---------- deriveStacked (creator escape hatch) ----------
{
  log('No render_hint → responsive (not stacked)', deriveStacked(undefined) === false);
  log('render_hint=split → responsive', deriveStacked('split') === false);
  log('render_hint=stacked → stacked on desktop', deriveStacked('stacked') === true);
  log('Unknown hint → responsive', deriveStacked('weird') === false);
}

// ---------- deriveSharedRunBanner (?run=<id> deep-link banner) ----------
{
  log(
    'No initial run id → no banner',
    deriveSharedRunBanner({ initialRunId: null, currentRunId: null, phase: 'ready' }) === false,
  );
  log(
    'Initial run set, same id, done → banner visible',
    deriveSharedRunBanner({ initialRunId: 'run-1', currentRunId: 'run-1', phase: 'done' }) === true,
  );
  log(
    'Initial run set, state cleared → no banner',
    deriveSharedRunBanner({ initialRunId: 'run-1', currentRunId: null, phase: 'ready' }) === false,
  );
  log(
    'Initial run set, user re-ran (different id) → no banner',
    deriveSharedRunBanner({ initialRunId: 'run-1', currentRunId: 'run-2', phase: 'done' }) === false,
  );
  log(
    'Initial run set but streaming (not done) → no banner',
    deriveSharedRunBanner({ initialRunId: 'run-1', currentRunId: 'run-1', phase: 'streaming' }) ===
      false,
  );
}

// ---------- jobToRunRecord adapter ----------
{
  const succeeded = {
    id: 'job-1',
    slug: 'demo',
    app_id: 'app-1',
    action: 'go',
    status: 'succeeded',
    input: { prompt: 'hi' },
    output: { result: 42 },
    error: null,
    run_id: 'run-42',
    webhook_url: null,
    timeout_ms: 60000,
    max_retries: 0,
    attempts: 1,
    created_at: '2026-04-18T10:00:00Z',
    started_at: '2026-04-18T10:00:01Z',
    finished_at: '2026-04-18T10:00:05Z',
  };
  const r = __test__.jobToRunRecord(succeeded, 'go');
  log('Job → Run: id prefers run_id', r.id === 'run-42');
  log('Job → Run: succeeded → status=success', r.status === 'success');
  log('Job → Run: duration computed', r.duration_ms === 4000);
  log('Job → Run: outputs preserved', r.outputs?.result === 42);
  log('Job → Run: inputs preserved', r.inputs?.prompt === 'hi');
  log('Job → Run: error_type null on success', r.error_type === null);

  const failed_ = { ...succeeded, status: 'failed', error: { message: 'boom' }, output: null };
  const rf = __test__.jobToRunRecord(failed_, 'go');
  log('Job → Run: failed → status=error', rf.status === 'error');
  log('Job → Run: error stringified', rf.error === JSON.stringify({ message: 'boom' }));
  log('Job → Run: error_type=runtime_error on fail', rf.error_type === 'runtime_error');

  const cancelled = { ...succeeded, status: 'cancelled', output: null };
  const rc = __test__.jobToRunRecord(cancelled, 'go');
  log('Job → Run: cancelled → error_type=cancelled', rc.error_type === 'cancelled');

  const noFinish = { ...succeeded, finished_at: null };
  const rn = __test__.jobToRunRecord(noFinish, 'go');
  log('Job → Run: missing finished_at → duration null', rn.duration_ms === null);
}

// ---------- coerceInputs (array fields) ----------
{
  const spec = {
    label: 'Scout',
    inputs: [
      { name: 'hashtags', type: 'textarea', label: 'Hashtags' },
      { name: 'prompt', type: 'text', label: 'Prompt' },
    ],
    outputs: [],
  };
  const out1 = __test__.coerceInputs({ hashtags: 'vienna, berlin, paris', prompt: 'hi' }, spec);
  log('Coerce: comma-separated → array', Array.isArray(out1.hashtags) && out1.hashtags.length === 3);
  log('Coerce: non-array keys pass through', out1.prompt === 'hi');

  const out2 = __test__.coerceInputs({ hashtags: 'a\nb\nc', prompt: '' }, spec);
  log('Coerce: newline-separated → array', out2.hashtags.length === 3 && out2.hashtags[1] === 'b');

  const out3 = __test__.coerceInputs({ hashtags: ['already', 'array'], prompt: 'x' }, spec);
  log('Coerce: already-array preserved', out3.hashtags[0] === 'already');

  const out4 = __test__.coerceInputs({ hashtags: '', prompt: '' }, spec);
  log('Coerce: empty string → empty array', Array.isArray(out4.hashtags) && out4.hashtags.length === 0);
}

// ---------- buildInitialInputs (prefill overrides) ----------
{
  const spec = {
    label: 'Go',
    inputs: [
      { name: 'prompt', type: 'text', label: 'Prompt', default: 'hello' },
      { name: 'count', type: 'number', label: 'Count', default: 3 },
    ],
    outputs: [],
  };
  const i1 = __test__.buildInitialInputs(spec);
  log('Initial inputs: default used', i1.prompt === 'hello' && i1.count === 3);

  const i2 = __test__.buildInitialInputs(spec, { prompt: 'override' });
  log('Initial inputs: overrides win', i2.prompt === 'override' && i2.count === 3);
}

// ---------- getDefaultActionSpec ----------
{
  const app = {
    manifest: {
      actions: {
        first: { label: 'First', inputs: [], outputs: [] },
        second: { label: 'Second', inputs: [], outputs: [] },
      },
    },
  };
  const entry = __test__.getDefaultActionSpec(app);
  log('Default action: picks first entry', entry?.action === 'first');

  const empty = { manifest: { actions: {} } };
  log('Default action: empty manifest → null', __test__.getDefaultActionSpec(empty) === null);
}

// ---------- summarizeInputs (past runs snippet) ----------
{
  log('Summarize: null → empty', __test__.summarizeInputs(null) === '');
  log('Summarize: empty obj → (no input)', __test__.summarizeInputs({}) === '(no input)');
  log(
    'Summarize: first string value',
    __test__.summarizeInputs({ prompt: 'hello world', count: 3 }) === 'hello world',
  );
  log(
    'Summarize: truncates at 60 chars',
    __test__.summarizeInputs({ prompt: 'x'.repeat(100) }).length === 58 &&
      __test__.summarizeInputs({ prompt: 'x'.repeat(100) }).endsWith('…'),
  );
  log(
    'Summarize: non-string stringified',
    __test__.summarizeInputs({ data: { nested: true } }) === '{"nested":true}',
  );
}

// ---------- formatWhen (relative timestamps) ----------
{
  const now = Date.now();
  const s = __test__.formatWhen(new Date(now - 30_000).toISOString());
  log('formatWhen: <1m → just now', s === 'just now');

  const m5 = __test__.formatWhen(new Date(now - 5 * 60_000).toISOString());
  log('formatWhen: 5m ago', m5 === '5m ago');

  const h2 = __test__.formatWhen(new Date(now - 2 * 60 * 60_000).toISOString());
  log('formatWhen: 2h ago', h2 === '2h ago');

  const d3 = __test__.formatWhen(new Date(now - 3 * 24 * 60 * 60_000).toISOString());
  log('formatWhen: >24h → localized date', typeof d3 === 'string' && d3.length > 0 && !d3.endsWith('ago'));

  log('formatWhen: invalid → empty', __test__.formatWhen('not-a-date') === '');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
