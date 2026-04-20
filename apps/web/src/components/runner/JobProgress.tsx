// JobProgress — queued / running state card for async app runs.
//
// Shown while an async job (v0.3.0 job queue) transitions through
// queued -> running -> succeeded/failed/cancelled. The parent (RunSurface)
// polls GET /api/:slug/jobs/:id and passes each snapshot into this
// component. On a terminal status the parent flips to the OutputPanel
// so this component only renders pre-terminal states.
//
// Contract with the backend:
//   POST /api/:slug/jobs           -> { job_id, status: 'queued', poll_url, cancel_url }
//   GET  /api/:slug/jobs/:job_id   -> JobRecord (polled via api.pollJob)
//   POST /api/:slug/jobs/:id/cancel
//
// Backend route: apps/server/src/routes/jobs.ts (live on main since v0.3.0).

import type { AppDetail, PickResult } from '../../lib/types';
import type { JobRecord } from '../../lib/types';
import { useElapsed, formatElapsed, formatEstimate } from '../../hooks/useElapsed';

interface Props {
  app: PickResult;
  job: JobRecord | null;
  onCancel?: () => void;
  /**
   * Fix 2 (2026-04-20): when provided, the header shows "~Ns typical"
   * from `appDetail.manifest.estimated_duration_ms` (or the per-action
   * override) next to the live elapsed timer so a slow async job (30s+)
   * reads as expected progress rather than a hung queue.
   */
  appDetail?: AppDetail;
  /** Action being run — picks the per-action estimate when set. */
  action?: string;
  /**
   * Client-side run start time. Falls back to `job.started_at` from the
   * server. Used for the live elapsed timer so the user sees time
   * actually moving, including while the job is still queued.
   */
  startedAt?: Date | number | null;
}

export function JobProgress({ app, job, onCancel, appDetail, action, startedAt }: Props) {
  const status = job?.status ?? 'queued';
  const label = status === 'queued' ? 'Queued' : status === 'running' ? 'Running' : status;

  // Prefer the server's `started_at` once the job has moved to running;
  // fall back to the client-side start timestamp (set by RunSurface when
  // the user clicked Run) so the timer starts immediately, even while
  // the job is still in the queue.
  const serverStart = job?.started_at ? new Date(job.started_at).getTime() : null;
  const clientStart =
    startedAt == null
      ? null
      : typeof startedAt === 'number'
        ? startedAt
        : startedAt.getTime();
  const startMs = serverStart ?? clientStart;

  const elapsed = useElapsed(startMs);
  const estimate = pickEstimate(appDetail, action);

  return (
    <div className="assistant-turn" data-testid="job-progress">
      <div className="run-header" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span>{app.name}</span>
        <span className="t-dim">·</span>
        <span data-testid="job-status-pill" style={{ color: 'var(--muted)' }}>
          {label}
        </span>
        {elapsed != null && (
          <>
            <span className="t-dim">·</span>
            <span
              data-testid="job-elapsed"
              style={{
                color: 'var(--muted)',
                fontVariantNumeric: 'tabular-nums',
              }}
              aria-label={`Elapsed ${Math.floor(elapsed / 1000)} seconds`}
            >
              {formatElapsed(elapsed)}
            </span>
          </>
        )}
        {estimate > 0 && (
          <>
            <span className="t-dim">·</span>
            <span
              data-testid="job-estimate"
              style={{ color: 'var(--muted)', fontSize: 12 }}
            >
              {formatEstimate(estimate)}
            </span>
          </>
        )}
        {job?.attempts != null && job.attempts > 1 && (
          <>
            <span className="t-dim">·</span>
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>attempt {job.attempts}</span>
          </>
        )}
      </div>

      <div className="app-expanded-card">
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '4px 0 12px',
          }}
        >
          <Spinner active={status === 'running' || status === 'queued'} />
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
              {status === 'queued'
                ? 'Your job is queued.'
                : 'Your job is running.'}
            </p>
            <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
              {status === 'queued'
                ? 'A worker will pick this up in a moment. You can leave this page; the job keeps running.'
                : 'Polling for completion. This page updates when the run finishes.'}
            </p>
          </div>
        </div>

        <IndeterminateBar active={status !== 'cancelled'} />

        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 14,
            fontSize: 12,
            color: 'var(--muted)',
          }}
        >
          <div style={{ fontFamily: 'JetBrains Mono, monospace' }}>
            {job?.id ? `job ${job.id.slice(0, 12)}…` : 'creating job…'}
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            {onCancel && job && status !== 'cancelled' && (
              <button
                type="button"
                className="btn-ghost"
                onClick={onCancel}
                data-testid="job-cancel-btn"
                style={{ padding: '6px 12px', fontSize: 12 }}
              >
                Cancel
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function pickEstimate(appDetail: AppDetail | undefined, action: string | undefined): number {
  if (!appDetail?.manifest) return 0;
  const m = appDetail.manifest;
  if (action && m.actions?.[action]?.estimated_duration_ms) {
    return m.actions[action].estimated_duration_ms as number;
  }
  return typeof m.estimated_duration_ms === 'number' ? m.estimated_duration_ms : 0;
}

function Spinner({ active }: { active: boolean }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: 22,
        height: 22,
        borderRadius: '50%',
        border: '2px solid var(--line)',
        borderTopColor: active ? 'var(--accent, #1a7f37)' : 'var(--muted)',
        animation: active ? 'floom-spin 1s linear infinite' : 'none',
        flexShrink: 0,
      }}
    />
  );
}

function IndeterminateBar({ active }: { active: boolean }) {
  return (
    <div
      style={{
        height: 4,
        background: 'var(--line)',
        borderRadius: 2,
        overflow: 'hidden',
        position: 'relative',
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          height: '100%',
          width: '40%',
          background: 'var(--accent, #1a7f37)',
          borderRadius: 2,
          animation: active ? 'floom-indeterminate 1.6s ease-in-out infinite' : 'none',
        }}
      />
    </div>
  );
}
