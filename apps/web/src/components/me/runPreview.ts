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
