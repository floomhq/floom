#!/usr/bin/env node
// Rescue Fix #1 (2026-04-21): probe every live hub app end-to-end.
//
// For each app in /api/hub:
//   1. fetch /api/hub/:slug for the full manifest
//   2. pick the action with the fewest required inputs
//   3. synthesize inputs from type defaults
//   4. POST /api/:slug/run with an authed session cookie
//   5. poll /api/run/:id for up to POLL_TIMEOUT_MS
//   6. classify: PASS / FAIL_UPSTREAM / FAIL_FLOOM / SKIP
//   7. optionally tag for prune (irrelevant categories + obvious non-consumer)
//
// Output:
//   - stdout: progress lines, concurrency 4
//   - /tmp/hub-verify-report.json: raw results
//
// Budget: ~30 min wall, 4-wide concurrency, 8s timeout per probe + 15s poll.

import fs from 'node:fs';

const BASE = process.env.BASE || 'https://floom.dev';
const COOKIE = process.env.COOKIE || '';
const CONCURRENCY = Number(process.env.CONCURRENCY || 4);
const PROBE_TIMEOUT_MS = Number(process.env.PROBE_TIMEOUT_MS || 8000);
const POLL_TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MS || 15000);
const POLL_INTERVAL_MS = 500;
const REPORT_PATH = process.env.REPORT_PATH || '/tmp/hub-verify-report.json';

if (!COOKIE) {
  console.error('FATAL: COOKIE env var missing (set to __Secure-floom.session_token=...).');
  process.exit(2);
}

// Low-value / wrong-audience slugs — pruned by relevance even if the
// endpoint technically returns 200. These are APIs nobody in the
// Floom ICP (vibecoder creators + biz users building internal tools)
// would reasonably want. Policy call from brief.
const RELEVANCE_PRUNE = new Set([
  // meta / directory APIs
  'apis-guru',
  // government / compliance APIs
  'healthcare',
  'bills-api',
  'canada-holidays-api',
  'bc-geographical-names-web-service-rest-api',
  'bng2latlong',
  // banking / regulated finance
  'afterbanks-api',
  '1forge-finance-apis',
  'fraudlabs-pro-fraud-detection',
  // super-niche / medical
  'medcorder-nearby-doctor-api',
  'd-d-5e-api',
  // energy meta
  'corrently-io',
  // low-value catalog specs
  'flickr-api-schema',
  'hydra-movies',
]);

function synth(input) {
  if (input.default !== undefined && input.default !== null) return input.default;
  switch (input.type) {
    case 'text':
    case 'string':
      if (/url/i.test(input.name)) return 'https://example.com';
      if (/email/i.test(input.name)) return 'test@example.com';
      if (/country/i.test(input.name)) return 'US';
      if (/city/i.test(input.name)) return 'London';
      if (/lat|latitude/i.test(input.name)) return '51.5';
      if (/lon|lng|longitude/i.test(input.name)) return '-0.12';
      if (/zip|post/i.test(input.name)) return '10115';
      return 'test';
    case 'number':
    case 'integer':
    case 'int':
      return 1;
    case 'boolean':
    case 'bool':
      return false;
    case 'enum':
      return Array.isArray(input.options) && input.options.length ? input.options[0] : null;
    case 'url':
      return 'https://example.com';
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'test';
  }
}

function pickSimplestAction(actions) {
  let best = null;
  for (const [name, spec] of Object.entries(actions || {})) {
    const reqCount = (spec.inputs || []).filter((i) => i.required).length;
    const totalCount = (spec.inputs || []).length;
    if (
      !best ||
      reqCount < best.reqCount ||
      (reqCount === best.reqCount && totalCount < best.totalCount)
    ) {
      best = { name, spec, reqCount, totalCount };
    }
  }
  return best;
}

async function fetchWithTimeout(url, opts = {}, ms = PROBE_TIMEOUT_MS) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

function classify(run, detail) {
  if (!run) return { verdict: 'FAIL_FLOOM', reason: 'no_run_record' };
  const status = run.status;
  const outputs = run.outputs;
  const up = run.upstream_status;
  const errType = run.error_type || '';
  const err = run.error || '';

  if (status === 'success' && outputs != null) {
    // Is output meaningful? Detect empty / HTML landing / signup gate.
    const raw = typeof outputs === 'string' ? outputs : JSON.stringify(outputs);
    if (!raw || raw === '{}' || raw === '[]' || raw === '""') {
      return { verdict: 'FAIL_UPSTREAM', reason: 'empty_output' };
    }
    if (/<!doctype html|<html/i.test(raw)) {
      return { verdict: 'FAIL_UPSTREAM', reason: 'html_landing_page' };
    }
    if (/sign[_ -]?up|log[_ -]?in|authent(ic)?ate|unauthorized|forbidden|api[_ -]?key/i.test(raw.slice(0, 400))) {
      return { verdict: 'FAIL_UPSTREAM', reason: 'auth_gate' };
    }
    return { verdict: 'PASS', reason: 'ok', bytes: raw.length };
  }

  // Error cases.
  if (errType === 'floom_internal_error' || /^(500|502|503|504)$/.test(String(up)) === false && /ECONNREFUSED|EADDR|out of memory|build_error/i.test(err)) {
    return { verdict: 'FAIL_FLOOM', reason: errType || 'runtime_error' };
  }
  if (errType === 'user_input_error' || (up && up >= 400 && up < 500 && up !== 401 && up !== 403)) {
    return { verdict: 'SKIP', reason: 'input_synth_rejected' };
  }
  if (errType === 'auth_error' || up === 401 || up === 403) {
    return { verdict: 'FAIL_UPSTREAM', reason: 'auth_required' };
  }
  if (errType === 'upstream_outage' || (up && up >= 500)) {
    return { verdict: 'FAIL_UPSTREAM', reason: 'upstream_5xx' };
  }
  if (errType === 'network_unreachable' || /fetch failed|ENOTFOUND|ECONNREFUSED|timeout/i.test(err)) {
    return { verdict: 'FAIL_UPSTREAM', reason: 'network' };
  }
  return { verdict: 'FAIL_UPSTREAM', reason: errType || 'unknown', err: err.slice(0, 200) };
}

async function probeApp(slug) {
  const out = { slug };
  try {
    const detailRes = await fetchWithTimeout(`${BASE}/api/hub/${slug}`, {
      headers: { cookie: COOKIE },
    });
    if (!detailRes.ok) {
      out.verdict = 'SKIP';
      out.reason = `detail_${detailRes.status}`;
      return out;
    }
    const detail = await detailRes.json();
    out.name = detail.name;
    out.category = detail.category;

    const action = pickSimplestAction(detail.manifest?.actions || {});
    if (!action) {
      out.verdict = 'SKIP';
      out.reason = 'no_actions';
      return out;
    }
    out.action = action.name;
    out.required_inputs = action.reqCount;

    // Skip if we can't auto-synth all required inputs (object type without
    // default, or file uploads, or schemas we can't guess).
    const inputs = {};
    let skip = false;
    for (const inp of action.spec.inputs || []) {
      if (inp.required) {
        const v = synth(inp);
        if (v === null || v === undefined) {
          skip = true;
          out.skip_reason = `cant_synth_${inp.name}`;
          break;
        }
        inputs[inp.name] = v;
      } else if (inp.default !== undefined) {
        inputs[inp.name] = inp.default;
      }
    }
    if (skip) {
      out.verdict = 'SKIP';
      out.reason = out.skip_reason;
      return out;
    }
    out.inputs = inputs;

    const startRes = await fetchWithTimeout(`${BASE}/api/${slug}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: COOKIE },
      body: JSON.stringify({ inputs, action: action.name }),
    });
    const startBody = await startRes.json().catch(() => ({}));
    if (!startRes.ok || !startBody.run_id) {
      out.verdict = startRes.status >= 500 ? 'FAIL_FLOOM' : 'FAIL_UPSTREAM';
      out.reason = `start_${startRes.status}`;
      out.start_error = startBody.error;
      return out;
    }
    const runId = startBody.run_id;
    out.run_id = runId;

    // Poll for completion.
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    let run = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      const pr = await fetchWithTimeout(`${BASE}/api/run/${runId}`, {
        headers: { cookie: COOKIE },
      }, 4000).catch(() => null);
      if (!pr || !pr.ok) continue;
      const pj = await pr.json().catch(() => null);
      if (!pj) continue;
      run = pj;
      if (['success', 'error', 'timeout'].includes(run.status)) break;
    }
    if (!run) {
      out.verdict = 'FAIL_FLOOM';
      out.reason = 'no_poll_response';
      return out;
    }
    if (!['success', 'error', 'timeout'].includes(run.status)) {
      out.verdict = 'FAIL_UPSTREAM';
      out.reason = 'poll_timeout';
      return out;
    }

    const verdict = classify(run, detail);
    Object.assign(out, verdict, { upstream_status: run.upstream_status, duration_ms: run.duration_ms });
    return out;
  } catch (err) {
    out.verdict = 'FAIL_FLOOM';
    out.reason = err.name === 'AbortError' ? 'probe_timeout' : 'probe_exception';
    out.err = (err.message || '').slice(0, 200);
    return out;
  }
}

async function main() {
  const hubRes = await fetch(`${BASE}/api/hub`);
  const hub = await hubRes.json();
  console.log(`Hub has ${hub.length} apps. Concurrency ${CONCURRENCY}, probe timeout ${PROBE_TIMEOUT_MS}ms.`);

  const queue = hub.map((a) => a.slug);
  const results = [];
  let done = 0;

  async function worker() {
    while (queue.length) {
      const slug = queue.shift();
      if (!slug) break;
      const r = await probeApp(slug);
      if (RELEVANCE_PRUNE.has(slug) && r.verdict === 'PASS') {
        r.prune_relevance = true;
      }
      results.push(r);
      done++;
      const marker =
        r.verdict === 'PASS' ? 'PASS' :
        r.verdict === 'SKIP' ? 'skip' : 'FAIL';
      console.log(`[${done}/${hub.length}] ${marker.padEnd(4)} ${slug} ${r.reason || ''}`);
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  // Tabulate.
  const by = {
    PASS: results.filter((r) => r.verdict === 'PASS' && !r.prune_relevance),
    PASS_pruned: results.filter((r) => r.prune_relevance),
    SKIP: results.filter((r) => r.verdict === 'SKIP'),
    FAIL_UPSTREAM: results.filter((r) => r.verdict === 'FAIL_UPSTREAM'),
    FAIL_FLOOM: results.filter((r) => r.verdict === 'FAIL_FLOOM'),
  };

  const hide = new Set([
    ...by.FAIL_UPSTREAM.map((r) => r.slug),
    ...by.PASS_pruned.map((r) => r.slug),
    ...RELEVANCE_PRUNE,
  ]);

  // Also hide SKIPs where the slug is in RELEVANCE_PRUNE (already covered)
  // but keep SKIPs that are simply un-synthable — they may still be useful.

  const report = {
    generated_at: new Date().toISOString(),
    total: results.length,
    counts: {
      pass: by.PASS.length,
      pass_pruned_relevance: by.PASS_pruned.length,
      skip: by.SKIP.length,
      fail_upstream: by.FAIL_UPSTREAM.length,
      fail_floom: by.FAIL_FLOOM.length,
    },
    hide_slugs: [...hide].sort(),
    results,
  };
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(report.counts, null, 2));
  console.log(`\nHide slugs (${hide.size}):`);
  console.log([...hide].sort().join(','));
  console.log(`\nKeep (${results.length - hide.size}):`);
  console.log(results.filter((r) => !hide.has(r.slug)).map((r) => r.slug).join(','));
  console.log(`\nReport saved to ${REPORT_PATH}`);
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
