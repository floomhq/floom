// v15.1 /me treats each row in me_runs as a single-turn "thread" while a
// real threads schema doesn't exist. The helpers here derive a human
// readable title from the run's inputs and group a flat list of runs
// into Today / Yesterday / Earlier buckets for the left rail.

import type { MeRunSummary } from './types';

export interface ThreadGroups {
  today: MeRunSummary[];
  yesterday: MeRunSummary[];
  earlier: MeRunSummary[];
}

export function groupThreads(runs: MeRunSummary[]): ThreadGroups {
  const now = new Date();
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const groups: ThreadGroups = { today: [], yesterday: [], earlier: [] };
  for (const r of runs) {
    const t = new Date(r.started_at).getTime();
    if (Number.isNaN(t)) {
      groups.earlier.push(r);
      continue;
    }
    if (t >= startOfToday) groups.today.push(r);
    else if (t >= startOfYesterday) groups.yesterday.push(r);
    else groups.earlier.push(r);
  }
  return groups;
}

export function threadTitle(run: MeRunSummary): string {
  const inputs = run.inputs;
  if (inputs && typeof inputs === 'object') {
    const prompt = inputs['prompt'];
    if (typeof prompt === 'string' && prompt.trim()) return prompt.trim();
    for (const value of Object.values(inputs)) {
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  }
  if (run.action && run.action !== 'run') return run.action;
  return `Run #${run.id.slice(0, 6)}`;
}

export function threadTimeLabel(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const diffMs = now.getTime() - d.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const startOfToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const startOfYesterday = startOfToday - 86400000;
  const startOfLastWeek = startOfToday - 6 * 86400000;
  const t = d.getTime();

  if (t >= startOfToday) {
    if (diffSec < 60) return `${Math.max(1, diffSec)}s`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m`;
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  if (t >= startOfYesterday) return 'Yesterday';
  if (t >= startOfLastWeek) {
    return d.toLocaleDateString([], { weekday: 'short' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
