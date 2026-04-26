import type { MeRunSummary } from '../../lib/types';

export function runIdShort(id: string | null | undefined): string {
  if (!id) return '';
  const trimmed = id.replace(/^run_/, '');
  return trimmed.slice(0, 8);
}

export function runOutputPreviewLine(run: MeRunSummary): string | null {
  const output = run.outputs;
  if (output == null || output === '') return null;

  if (typeof output === 'string') {
    const text = output.replace(/\s+/g, ' ').trim();
    return text ? truncate(text, 96) : null;
  }

  if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;
    const direct =
      typeof record['text'] === 'string'
        ? record['text']
        : typeof record['message'] === 'string'
          ? record['message']
          : typeof record['result'] === 'string'
            ? record['result']
            : null;
    if (direct && String(direct).trim()) {
      return truncate(String(direct).replace(/\s+/g, ' ').trim(), 96);
    }
  }

  try {
    const raw = JSON.stringify(output);
    if (raw.length <= 104) return raw;
    return `${raw.slice(0, 101)}…`;
  } catch {
    return null;
  }
}

export function runSummary(run: MeRunSummary): string | null {
  const inputs = run.inputs;
  if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
    const prompt = inputs['prompt'];
    if (typeof prompt === 'string' && prompt.trim()) {
      return truncate(prompt.trim(), 90);
    }
    for (const value of Object.values(inputs)) {
      if (typeof value === 'string' && value.trim()) {
        return truncate(value.trim(), 90);
      }
    }
    const entries = Object.entries(inputs).filter(
      ([, value]) =>
        value !== null && (typeof value === 'number' || typeof value === 'boolean'),
    );
    if (entries.length > 0) {
      const [key, value] = entries[0];
      return truncate(`${key}: ${value}`, 90);
    }
    const keyCount = Object.keys(inputs).length;
    if (keyCount > 0) return `${keyCount} input${keyCount === 1 ? '' : 's'}`;
  }

  if (run.action && run.action !== 'run') return run.action;
  return null;
}

export function runPreviewText(run: MeRunSummary): string {
  return runOutputPreviewLine(run) || runSummary(run) || fallbackStatusCopy(run.status);
}

function fallbackStatusCopy(status: MeRunSummary['status']): string {
  if (status === 'success') return 'Completed run';
  if (status === 'running') return 'Run in progress';
  if (status === 'pending') return 'Queued';
  return 'Run needs attention';
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return `${str.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Builds a deep-link to an app surface that prefills the form with a
 * previous run's inputs. Used by the Re-run affordances on /me — the app
 * tiles in "Your apps" and the per-row re-run button on "Recent runs".
 *
 * If no runId is provided, falls back to the bare app surface.
 */
export function buildRerunHref(
  slug: string,
  runId?: string | null,
  action?: string | null,
): string {
  if (!runId) return `/p/${slug}`;
  const search = new URLSearchParams();
  search.set('rerun', runId);
  if (action) search.set('action', action);
  return `/p/${slug}?${search.toString()}`;
}

/**
 * Human-readable 1-line snippet of the run's INPUT side. Used by the v23
 * /me/runs row's `.snip` line and the mobile `.m-list-item` `.nm`
 * sub-line. Falls back to runPreviewText for unknown shapes.
 *
 * Examples:
 *   - { your_url: 'stripe.com', competitor_url: 'adyen.com' }
 *     → "stripe.com vs adyen.com"
 *   - { url: 'floom.dev' } → "floom.dev"
 *   - { prompt: '"Thanks for the intro..."' } → "Thanks for the intro..."
 *   - { token: 'eyJ...' } → "eyJhbGciOiJIUzI1NiIs..."
 */
export function runSnippetText(run: MeRunSummary): string {
  const inputs = run.inputs;
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
    return runPreviewText(run);
  }
  const record = inputs as Record<string, unknown>;

  // competitor-lens shape: your_url + competitor_url
  const yourUrl = stringOrNull(record['your_url']);
  const competitorUrl = stringOrNull(record['competitor_url']);
  if (yourUrl && competitorUrl) {
    return truncate(`${cleanUrl(yourUrl)} vs ${cleanUrl(competitorUrl)}`, 96);
  }

  // single-url shape: ai-readiness-audit, opengraph, etc.
  const url = stringOrNull(record['url']);
  if (url) return truncate(cleanUrl(url), 96);

  // pitch-coach + opendraft shape: prompt, message, draft
  const prompt =
    stringOrNull(record['prompt']) ||
    stringOrNull(record['message']) ||
    stringOrNull(record['draft']) ||
    stringOrNull(record['pitch']) ||
    stringOrNull(record['text']);
  if (prompt) return truncate(prompt.replace(/\s+/g, ' ').trim(), 96);

  // jwt-decode shape: token
  const token = stringOrNull(record['token']);
  if (token) return truncate(token.replace(/\s+/g, ' ').trim(), 96);

  // first non-empty string field
  for (const value of Object.values(record)) {
    if (typeof value === 'string' && value.trim()) {
      return truncate(value.replace(/\s+/g, ' ').trim(), 96);
    }
  }

  // fall back to existing helper
  return runPreviewText(run);
}

/**
 * Human-readable 1-line summary of the run's OUTPUT side. Used by the
 * v23 /me/runs row's `.out` line. Returns null when nothing useful can
 * be summarized (caller should hide the line).
 *
 * Per-app schemas:
 *   - competitor-lens → "Winner: stripe (...)"
 *   - ai-readiness-audit → "Score: 8.4/10. 3 risks. 3 wins."
 *   - pitch-coach → "3 critiques + 3 rewrites + TL;DR"
 *   - generic → first text/message/result/summary string
 */
export function runOutputSummary(run: MeRunSummary): string | null {
  if (run.status === 'error' || run.status === 'timeout') {
    const err = run.error;
    if (err && err.trim()) {
      return truncate(`Failed: ${err.replace(/\s+/g, ' ').trim()}`, 96);
    }
    return 'Failed';
  }
  if (run.status === 'running' || run.status === 'pending') return null;

  const output = run.outputs;
  if (output == null || output === '') return null;

  if (typeof output === 'string') {
    const text = output.replace(/\s+/g, ' ').trim();
    return text ? truncate(text, 96) : null;
  }

  if (typeof output === 'object' && output !== null && !Array.isArray(output)) {
    const record = output as Record<string, unknown>;

    // competitor-lens: { winner, verdict, ... }
    const winner = stringOrNull(record['winner']);
    const verdict = stringOrNull(record['verdict']) || stringOrNull(record['summary']);
    if (winner && verdict) {
      return truncate(`Winner: ${winner}. ${verdict}`, 96);
    }
    if (winner) return truncate(`Winner: ${winner}`, 96);

    // ai-readiness-audit: { score, risks, opportunities }
    const score = record['score'];
    if (typeof score === 'number') {
      const risks = arrayLength(record['risks']);
      const wins =
        arrayLength(record['opportunities']) ||
        arrayLength(record['wins']) ||
        arrayLength(record['strengths']);
      const parts: string[] = [`Score: ${score}/10`];
      if (risks) parts.push(`${risks} risk${risks === 1 ? '' : 's'}`);
      if (wins) parts.push(`${wins} win${wins === 1 ? '' : 's'}`);
      return truncate(parts.join(' · '), 96);
    }

    // pitch-coach: { critiques, rewrites, tldr }
    const critiques = arrayLength(record['critiques']);
    const rewrites = arrayLength(record['rewrites']);
    if (critiques || rewrites) {
      const parts: string[] = [];
      if (critiques) parts.push(`${critiques} critique${critiques === 1 ? '' : 's'}`);
      if (rewrites) parts.push(`${rewrites} rewrite${rewrites === 1 ? '' : 's'}`);
      const tldr = stringOrNull(record['tldr']) || stringOrNull(record['summary']);
      if (tldr) parts.push(`TL;DR: ${tldr}`);
      return truncate(parts.join(' · '), 96);
    }

    // first text-like field
    const direct =
      stringOrNull(record['text']) ||
      stringOrNull(record['message']) ||
      stringOrNull(record['result']) ||
      stringOrNull(record['summary']);
    if (direct) return truncate(direct.replace(/\s+/g, ' ').trim(), 96);
  }

  return runOutputPreviewLine(run);
}

/** Format duration_ms as ms or s. Returns "—" when null. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)}s`;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function arrayLength(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

function cleanUrl(url: string): string {
  return url.replace(/^https?:\/\//, '').replace(/\/$/, '');
}
