// RunSurface — v16 one-surface run shell. Replaces the FloomApp chat-turn
// wrapper (YOU: / APP: bubbles, "Message X…" composer, New thread button).
//
// Layout:
//   Desktop (>=1024px): 2-column grid (input 2fr, output 3fr)
//   Mobile  (<1024px):  stacked (input on top, output below)
//   Creator opt-out: manifest.render.render_hint === 'stacked' forces
//                    single column on desktop too.
//
// Behaviour contract (matches the task spec):
//   - Empty-input apps (e.g. uuid): input card shows a single Run button and
//     a short "this app takes no input" note. No placeholder "Message X…".
//   - Zero chat turns. The input card stays mounted across runs; the output
//     card swaps between empty state, JobProgress, streaming logs, the
//     cascade-picked renderer, and errors — all in the same slot.
//   - Refine loop: after a successful run, the primary button flips from
//     "Run" to "Refine" unless manifest.render.refinable === false.
//   - Past runs live in a collapsed <details> below the grid.
//     Signed-out users see mode-aware CTA copy (waitlist vs sign-in).
//     Clicking a run navigates to /p/:slug?run=<id> which hydrates the run
//     via the PR #19 shared-run path.
//   - The renderer cascade (PR #66) is reused wholesale via OutputPanel,
//     including the Layer 1 CustomRendererHost iframe sandbox (PR #22).
//   - Async apps (is_async) route through JobProgress in the output slot.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import type {
  ActionSpec,
  AppDetail,
  JobRecord,
  MeRunSummary,
  OutputType,
  PickResult,
  RunRecord,
} from '../../lib/types';
import { OutputPanel } from './OutputPanel';
import { JobProgress } from './JobProgress';
import { CustomRendererHost } from './CustomRendererHost';
import { StreamingTerminal } from './StreamingTerminal';
import { ARRAY_INPUT_NAMES, InputField, maybePrependHttps } from './InputField';
import { useSession } from '../../hooks/useSession';
import * as api from '../../api/client';
import { ApiError, CsvRowCapExceededError, FileInputTooLargeError, getAppQuota, readUserGeminiKey } from '../../api/client';
import { buildPublicRunPath, getRunStartErrorMessage } from '../../lib/publicPermalinks';
import { useDeployEnabled } from '../../lib/flags';
import { waitlistHref } from '../../lib/waitlistCta';
import { BYOKModal } from '../BYOKModal';
import { FreeRunsStrip, useFreeRunsRefresher } from './FreeRunsStrip';
import { SampleOutputPreview, hasSampleForSlug } from './SampleOutputPreview';

export interface RunSurfaceResult {
  runId: string;
  output: string;
  exitCode: number;
}

export interface RunSurfaceProps {
  app: AppDetail;
  initialInputs?: Record<string, unknown>;
  /**
   * Hydrate the surface in the `done` phase with an already-finished run.
   * Wired by /p/:slug?run=<id> so a shared link renders the run's output
   * without re-executing. The caller clears the ?run param via
   * onResetInitialRun when the visitor presses Refine / Run again.
   */
  initialRun?: RunRecord | null;
  onResetInitialRun?: () => void;
  onResult?: (result: RunSurfaceResult) => void;
}

type Phase = 'ready' | 'streaming' | 'job' | 'done' | 'error';

interface RunState {
  phase: Phase;
  inputs: Record<string, unknown>;
  action: string;
  actionSpec: ActionSpec;
  /** Keeps track of whether at least one run has succeeded (flips Run → Refine). */
  hasRun: boolean;
  runId?: string;
  logs?: string[];
  jobId?: string;
  job?: JobRecord | null;
  cancelPoll?: () => void;
  run?: RunRecord;
  errorMessage?: string;
  /**
   * Issue #256 (2026-04-21): per-input validation errors. Rendered as
   * inline red ring + small text below the field instead of the old
   * "Something went wrong / Missing required input: X" panel. Cleared
   * the moment the user edits the field or flips the action tab.
   */
  inputErrors?: Record<string, string>;
}

/**
 * Return the creator-pinned `primary_action` when it points to a valid
 * key in the manifest (audit 2026-04-20, Fix 3). Falls through to the
 * first action for apps that didn't declare a primary — keeps every
 * existing app rendering unchanged.
 */
function getPrimaryActionName(app: AppDetail): string | null {
  const primary = app.manifest.primary_action;
  if (primary && typeof primary === 'string' && app.manifest.actions[primary]) {
    return primary;
  }
  return null;
}

function getDefaultActionSpec(app: AppDetail): { action: string; spec: ActionSpec } | null {
  const entries = Object.entries(app.manifest.actions);
  if (entries.length === 0) return null;
  // Honor creator-pinned primary_action (Fix 3): it dictates which tab
  // is active on first render for multi-action apps, so biz users see
  // the "start here" action instead of the first one alphabetically.
  const primary = getPrimaryActionName(app);
  if (primary) {
    return { action: primary, spec: app.manifest.actions[primary] };
  }
  const [action, spec] = entries[0];
  return { action, spec };
}

/** Slugs for deterministic one-shot apps; Refine is hidden even if mis-declared. (#86) */
const NON_REFINABLE_SLUGS = new Set([
  'uuid',
  'hash',
  'sha256',
  'sha512',
  'md5',
  'checksum',
]);

/**
 * Issue #86: suppress Refine for uuid/hash-style apps, non-textual outputs, or
 * explicit `render.refinable: false` (using existing manifest fields only).
 */
function isRefineSuppressedForApp(app: AppDetail): boolean {
  if (app.manifest?.render?.refinable === false) return true;
  if (NON_REFINABLE_SLUGS.has(app.slug)) return true;
  const def = getDefaultActionSpec(app);
  if (!def) return false;
  for (const o of def.spec.outputs ?? []) {
    if (o.type === 'image' || o.type === 'pdf' || o.type === 'file') return true;
  }
  if (def.spec.outputs?.length === 1) {
    const o = def.spec.outputs[0];
    const hint = `${o.name} ${o.label}`.toLowerCase();
    if (/\b(uuid|ulid|hash|sha-?256|sha-?512|md5|checksum|digest)\b/.test(hint)) {
      return true;
    }
  }
  return false;
}

/**
 * Upgrade 2 (2026-04-19): pick the entry action on mount. Honors an
 * optional `?action=<name>` URL param so multi-action apps can be linked
 * directly to a specific tab (e.g. /p/session-recall?action=report).
 * Falls back to the first action if the param is absent or unknown.
 */
function pickInitialAction(
  app: AppDetail,
  actionParam: string | null,
): { action: string; spec: ActionSpec } | null {
  if (actionParam && app.manifest.actions[actionParam]) {
    return { action: actionParam, spec: app.manifest.actions[actionParam] };
  }
  return getDefaultActionSpec(app);
}

function buildInitialInputs(
  spec: ActionSpec,
  overrides?: Record<string, unknown>,
): Record<string, unknown> {
  const inputs: Record<string, unknown> = {};
  for (const inp of spec.inputs) {
    inputs[inp.name] = overrides?.[inp.name] ?? inp.default ?? '';
  }
  return inputs;
}

function coerceInputs(
  inputs: Record<string, unknown>,
  spec: ActionSpec,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...inputs };
  for (const inp of spec.inputs) {
    // Fix 6 (2026-04-19): last-chance https:// prepend for URL fields at
    // submit time (in case the user pressed Enter before the field blurred).
    if (inp.type === 'url') {
      const raw = out[inp.name];
      if (typeof raw === 'string' && raw.length > 0) {
        out[inp.name] = maybePrependHttps(raw);
      }
    }
    if (!ARRAY_INPUT_NAMES.has(inp.name)) continue;
    const raw = out[inp.name];
    if (Array.isArray(raw)) continue;
    if (typeof raw === 'string') {
      out[inp.name] = raw
        .split(/[,\n]/)
        .map((p) => p.trim())
        .filter(Boolean);
    } else if (raw == null || raw === '') {
      out[inp.name] = [];
    }
  }
  return out;
}

/**
 * Issue #256 (2026-04-21): humanize an input's manifest label for error
 * copy. Strips a trailing "(optional)" marker and falls back to the
 * input `name` in Title Case when no label is present. Never returns
 * empty — callers render it into "Fill in X to run".
 */
function humanizeInputLabel(inp: {
  name: string;
  label?: string;
}): string {
  const raw = (inp.label ?? '').replace(/\s*\(optional\)\s*$/i, '').trim();
  if (raw) return raw;
  return inp.name
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((p) => (p.length > 0 ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p))
    .join(' ');
}

/**
 * Scan the coerced inputs against the action spec and return an
 * inline-error map for every required field that's missing. Empty strings
 * and empty arrays both count as missing. Non-required fields are ignored.
 */
function findMissingRequiredInputs(
  inputs: Record<string, unknown>,
  spec: ActionSpec,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const inp of spec.inputs) {
    if (!inp.required) continue;
    const value = inputs[inp.name];
    const isEmpty =
      value == null ||
      (typeof value === 'string' && value.trim() === '') ||
      (Array.isArray(value) && value.length === 0);
    if (isEmpty) {
      errors[inp.name] = `Fill in ${humanizeInputLabel(inp)} to run.`;
    }
  }
  return errors;
}

/**
 * Parse a server-thrown "Missing required input: <name>" into the same
 * shape as findMissingRequiredInputs, so the server-side validator and
 * the client-side pre-check both surface the same inline-error UI.
 * Returns null when the error doesn't match the pattern.
 */
function parseMissingRequiredInput(
  err: Error,
  spec: ActionSpec,
): Record<string, string> | null {
  const message = typeof err?.message === 'string' ? err.message : '';
  const m = message.match(/Missing required input:\s*([A-Za-z0-9_\-.]+)/i);
  if (!m) return null;
  const name = m[1];
  const inp = spec.inputs.find((i) => i.name === name);
  if (!inp) return null;
  return { [name]: `Fill in ${humanizeInputLabel(inp)} to run.` };
}

/**
 * Translate a client-side serialization error (oversized file or
 * CSV row-cap) into an `inputErrors` entry keyed on the input name, so
 * the UI shows the message inline on the offending field instead of as
 * a top-level "Run failed to start" banner.
 *
 * The error's `path` is shaped like `inputs.<name>` or
 * `inputs.<name>[2]` (array-valued inputs). We strip the `inputs.`
 * prefix and any trailing `[n]` index to recover the declared input
 * name from the manifest.
 */
function parseClientFileError(err: Error): Record<string, string> | null {
  if (!(err instanceof CsvRowCapExceededError) && !(err instanceof FileInputTooLargeError)) {
    return null;
  }
  const rawPath = err.path || '';
  const stripped = rawPath.replace(/^inputs\./, '');
  const name = stripped.replace(/\[\d+\].*$/, '');
  if (!name) return null;
  return { [name]: err.message };
}

function focusFirstFlaggedField(name: string | undefined): void {
  if (!name || typeof window === 'undefined') return;
  requestAnimationFrame(() => {
    const el = document.getElementById(`run-surface-inp-${name}`);
    if (el) {
      el.focus({ preventScroll: false });
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  });
}

function jobToRunRecord(job: JobRecord, action: string): RunRecord {
  const ok = job.status === 'succeeded';
  const startedAt = job.started_at || job.created_at;
  const finishedAt = job.finished_at;
  const duration =
    startedAt && finishedAt
      ? new Date(finishedAt).getTime() - new Date(startedAt).getTime()
      : null;
  const errorText =
    job.error == null
      ? null
      : typeof job.error === 'string'
        ? job.error
        : JSON.stringify(job.error);
  return {
    id: job.run_id || job.id,
    app_id: job.app_id,
    thread_id: null,
    action,
    inputs: job.input,
    outputs: job.output,
    status: ok ? 'success' : job.status === 'cancelled' ? 'error' : 'error',
    error: errorText,
    error_type: ok ? null : job.status === 'cancelled' ? 'cancelled' : 'runtime_error',
    duration_ms: duration,
    started_at: startedAt,
    finished_at: finishedAt,
    logs: '',
  };
}

/**
 * #626 v17 run banner helper: best-effort estimate of how many rows the
 * current run will process. Deliberately conservative — returns null
 * unless the inputs include an obviously row-oriented field. We'd
 * rather render a row-less "Running..." banner than invent progress for
 * apps that don't have a row dimension (codex review 2026-04-24: a
 * multiline `job_description` textarea is NOT a 4-row dataset).
 *
 * Accepted signals, in order:
 *   - Array-valued inputs registered in ARRAY_INPUT_NAMES (urls/items/etc).
 *   - String inputs whose name/label explicitly names a row-oriented
 *     concept (csv, rows, leads, list, items, entries). Header line is
 *     stripped when present.
 * Generic textareas (prompts, descriptions, JSONL pastes) do NOT count —
 * they have lines, but lines != rows.
 */
function estimateRowCount(
  inputs: Record<string, unknown>,
  spec: ActionSpec,
): number | null {
  // Name-based allowlist applied to BOTH array and string inputs — we
  // only call it a "row" when the field's name/label actually reads as
  // row-oriented. Prevents e.g. `hashtags: ['#a', '#b']` on ig-nano-scout
  // from being reported as "row 1 of 2" (codex review 2026-04-24).
  const ROW_ORIENTED_NAME = /\b(csv|rows?|leads?|urls?|list|items?|entries)\b/i;
  for (const inp of spec.inputs) {
    const value = inputs[inp.name];
    const fingerprint = `${inp.name} ${inp.label ?? ''}`;
    if (!ROW_ORIENTED_NAME.test(fingerprint)) continue;
    if (Array.isArray(value)) {
      if (value.length > 0) return value.length;
      continue;
    }
    if (typeof value === 'string' && value.length > 0) {
      const lines = value.split('\n').map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      // We deliberately do NOT strip a "header" line here. Reliable header
      // detection without a schema hint is a coin flip (codex review
      // 2026-04-24: `Acme,https://acme.com` would look like a header but
      // is a data row). We surface this count as "~N rows" in the UI so
      // a ±1 over/undercount from a present/absent header is honest.
      return lines.length;
    }
    // File inputs: no sync row-count available. Fall through to null.
  }
  return null;
}

/**
 * Return the first input value that's a user-uploaded CSV-ish File, so
 * the run banner can read its row count. Mirrors `estimateRowCount`'s
 * name-based heuristic (we only count files from clearly row-oriented
 * slots) and layers a filename/MIME check so a generic File input won't
 * trigger a misleading count. Returns null for every other shape.
 */
function pickCsvFileInput(
  inputs: Record<string, unknown>,
  spec: ActionSpec,
): File | null {
  if (typeof File === 'undefined') return null;
  const ROW_ORIENTED_NAME = /\b(csv|rows?|leads?|urls?|list|items?|entries)\b/i;
  for (const inp of spec.inputs) {
    const value = inputs[inp.name];
    if (!(value instanceof File)) continue;
    const fingerprint = `${inp.name} ${inp.label ?? ''}`;
    const name = value.name.toLowerCase();
    const mime = (value.type || '').toLowerCase();
    const looksRowOriented =
      ROW_ORIENTED_NAME.test(fingerprint) ||
      name.endsWith('.csv') ||
      name.endsWith('.tsv') ||
      mime === 'text/csv' ||
      mime === 'text/tab-separated-values';
    if (looksRowOriented) return value;
  }
  return null;
}

/**
 * Count non-empty newline-delimited rows in a CSV File. Caps at ~5MB so
 * the UI never blocks on pathological uploads — above the cap we bail
 * out and let the banner fall back to the row-less "Processing..."
 * label. Header is stripped when the first line has no digits and more
 * than one comma-separated field.
 */
async function countFileCsvRows(file: File): Promise<number | null> {
  const MAX_BYTES = 5 * 1024 * 1024;
  if (file.size > MAX_BYTES) return null;
  let text: string;
  try {
    text = await file.text();
  } catch {
    return null;
  }
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  // A single line is almost always a header-only template (the shipped
  // lead-scorer sample is `company,website,...` with nothing below).
  // Reporting "row 1" here would lie about work that doesn't exist
  // (codex review 2026-04-24).
  if (lines.length === 1) return null;
  // CSV/TSV uploads on Floom are documented to require a header row
  // (see examples/lead-scorer/README.md: "header row required"), so we
  // always strip the first line from the count. This matches the
  // shipped demo contract — a ±1 drift on creator apps that choose to
  // accept headerless CSVs is acceptable since the UI surfaces this as
  // "~N rows", not a precise commitment.
  return lines.length - 1;
}

/** Format milliseconds as mm:ss (used in the run banner). */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function RunSurface({
  app,
  initialInputs,
  initialRun,
  onResetInitialRun,
  onResult,
}: RunSurfaceProps) {
  // Upgrade 2 (2026-04-19): honor ?action=<name> on mount so multi-action
  // apps can be linked directly to a specific tab. Only the initial
  // value is consumed below so later param changes don't stomp on the
  // user's active selection. Tab clicks update the URL via
  // setSearchParams to keep links shareable.
  const [, setSearchParams] = useSearchParams();
  const initialActionParam = useMemo(() => {
    if (typeof window === 'undefined') return null;
    try {
      return new URLSearchParams(window.location.search).get('action');
    } catch {
      return null;
    }
    // Intentionally empty deps: we only want the initial URL at mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const defaultEntry = getDefaultActionSpec(app);
  const actionEntries = useMemo(
    () => Object.entries(app.manifest.actions) as Array<[string, ActionSpec]>,
    [app.manifest.actions],
  );
  const hasMultipleActions = actionEntries.length > 1;
  // Fix 3 (2026-04-20): creator-pinned primary action. When set, its
  // tab gets a "Primary" pill and a subtle green background so first-time
  // users see "start here" on apps with a long tab list (e.g. petstore
  // has 19 operations).
  const primaryActionName = useMemo(() => getPrimaryActionName(app), [app]);

  const [state, setState] = useState<RunState>(() => {
    const initialPick = pickInitialAction(app, initialActionParam);
    if (!initialPick) {
      return {
        phase: 'error',
        inputs: {},
        action: '',
        actionSpec: { label: '', inputs: [], outputs: [] },
        hasRun: false,
        errorMessage: 'No actions defined for this app.',
      };
    }
    if (initialRun) {
      const actionName =
        initialRun.action in app.manifest.actions
          ? initialRun.action
          : initialPick.action;
      const spec = app.manifest.actions[actionName] ?? initialPick.spec;
      return {
        phase: 'done',
        inputs: (initialRun.inputs as Record<string, unknown>) ?? buildInitialInputs(spec),
        action: actionName,
        actionSpec: spec,
        hasRun: true,
        runId: initialRun.id,
        run: initialRun,
      };
    }
    return {
      phase: 'ready',
      inputs: buildInitialInputs(initialPick.spec, initialInputs),
      action: initialPick.action,
      actionSpec: initialPick.spec,
      hasRun: false,
    };
  });

  // BYOK modal (launch 2026-04-21): when /api/run returns 429 byok_required
  // for the 3 demo slugs (lead-scorer / competitor-analyzer / resume-screener)
  // we pop this modal so the user can paste their own Gemini key and retry.
  // See apps/server/src/lib/byok-gate.ts and api/client.ts::startRun.
  //
  // 2026-04-25: the modal now supports a `proactive` mode, opened from
  // the new FreeRunsStrip so a user can supply their key BEFORE the 6th
  // run instead of being stopped by a surprise 429. Only the copy and
  // heading differ — the save/retry flow is identical.
  const [byokOpen, setByokOpen] = useState(false);
  const [byokMode, setByokMode] = useState<'exhausted' | 'proactive'>('exhausted');
  const [byokPayload, setByokPayload] = useState<{
    slug?: string;
    usage?: number;
    limit?: number;
    get_key_url?: string;
    message?: string;
  } | null>(null);

  // Bump on BYOK-modal close so the FreeRunsStrip refetches the quota
  // and re-reads localStorage for the user-key presence. No-op when the
  // slug isn't gated — the strip renders nothing in that case.
  const freeRunsRefresher = useFreeRunsRefresher();

  // v23 PR-D (2026-04-26): inline rate-limited upsell. We mirror the
  // FreeRunsStrip's quota fetch so the OutputSlot can render an inline
  // RateLimitedCard when the user has exhausted their free runs and
  // hasn't pasted a Gemini key — instead of (or alongside) the existing
  // BYOKModal which still fires for the click-Run-before-quota-loads
  // race. See decision doc §3.6 + §7.3 for the dual-render rule.
  const [byokExhausted, setByokExhausted] = useState(false);
  const [quotaResetWindowMs, setQuotaResetWindowMs] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const q = await getAppQuota(app.slug);
      if (cancelled) return;
      const hasKey = readUserGeminiKey() !== null;
      const remaining = q.remaining ?? Math.max(0, (q.limit ?? 0) - (q.usage ?? 0));
      // Only count as exhausted on gated slugs without a saved user key.
      // Saved key → unlimited (server skips the BYOK gate). Non-gated →
      // server never returns 429 byok_required, so the upsell is moot.
      setByokExhausted(q.gated === true && !hasKey && remaining <= 0);
      setQuotaResetWindowMs(q.window_ms ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [app.slug, freeRunsRefresher.refreshKey]);

  // #626 v17 run banner state — the banner (top of output area) shows a
  // live mm:ss timer + "Running: <action>..." label during streaming/job
  // phases. runStartedAt is pinned on the phase transition; elapsedMs
  // re-ticks every second so the timer stays current without hammering
  // React's render loop. Both reset to null on reaching `done`/`ready`/
  // `error` so a shared-run permalink (phase=done) sees nothing.
  const [runStartedAt, setRunStartedAt] = useState<number | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  // `isRunning` gates the banner + per-row feed. For async apps, the
  // `phase === 'job'` transition fires as soon as /api/:slug/jobs
  // returns (status=queued) — the worker hasn't started yet and
  // JobProgress still reads "Your job is queued." Reporting
  // "Running..." / "row 1 of M" there would contradict the output
  // panel, so we hold the banner until the job transitions to
  // `running`. Streaming (sync SSE) apps go live immediately.
  const isRunning =
    state.phase === 'streaming' ||
    (state.phase === 'job' && state.job?.status === 'running');
  useEffect(() => {
    if (!isRunning) {
      setRunStartedAt(null);
      setElapsedMs(0);
      return;
    }
    // For async jobs, seed from `job.started_at` (the server's clock, same
    // one JobProgress reads) so the banner's mm:ss stays in lockstep
    // with the existing progress card. Falls back to Date.now() for sync
    // streaming runs where the server has no separate "started" moment
    // visible client-side (codex review 2026-04-24).
    let startedAt = runStartedAt;
    if (startedAt == null) {
      const serverStart = state.job?.started_at;
      if (serverStart) {
        // Match JobProgress's parse exactly (`new Date(job.started_at)`)
        // so the two timers on screen agree to the second. The jobs API
        // returns raw SQLite `datetime('now')` strings without a
        // timezone, which both parses interpret as local time — that's
        // a pre-existing timezone bug tracked separately, but we MUST
        // NOT fix it here in isolation or the banner and the progress
        // card would diverge (codex review 2026-04-24 [P1]).
        const parsed = new Date(serverStart).getTime();
        startedAt = Number.isFinite(parsed) ? parsed : Date.now();
      } else {
        startedAt = Date.now();
      }
      setRunStartedAt(startedAt);
    }
    setElapsedMs(Math.max(0, Date.now() - startedAt));
    const id = window.setInterval(() => {
      setElapsedMs(Math.max(0, Date.now() - (startedAt as number)));
    }, 1000);
    return () => window.clearInterval(id);
  }, [isRunning, runStartedAt, state.job?.started_at]);

  // Estimated M for the per-row stream feed. We snapshot the SUBMITTED
  // payload (not state.inputs) at Run-click time via `submittedPayloadRef`
  // so that:
  //   (a) Edits the user makes between click and phase=streaming never
  //       reshape the banner. `isRunning` doesn't flip true until the
  //       server acknowledges dispatch (startRun / startJob resolves),
  //       which can take seconds on a slow upload.
  //   (b) Mutable form state (InputCard `running` disables fields, but
  //       we don't rely on that) can never drift M mid-run.
  // File-backed CSV inputs populate this asynchronously via
  // `countFileCsvRows` (cap 5MB so huge uploads don't hang the banner).
  const [runRowCount, setRunRowCount] = useState<number | null>(null);
  const submittedPayloadRef = useRef<{
    inputs: Record<string, unknown>;
    spec: ActionSpec;
  } | null>(null);
  useEffect(() => {
    if (!isRunning) {
      setRunRowCount(null);
      return;
    }
    const payload = submittedPayloadRef.current;
    if (!payload) {
      setRunRowCount(null);
      return;
    }
    const syncEstimate = estimateRowCount(payload.inputs, payload.spec);
    if (syncEstimate != null) {
      setRunRowCount(syncEstimate);
      return;
    }
    let cancelled = false;
    const fileInput = pickCsvFileInput(payload.inputs, payload.spec);
    if (!fileInput) {
      setRunRowCount(null);
      return;
    }
    countFileCsvRows(fileInput)
      .then((count) => {
        if (!cancelled && count != null) setRunRowCount(count);
      })
      .catch(() => {
        /* leave row count null on failure */
      });
    return () => {
      cancelled = true;
    };
  }, [isRunning]);
  const estimatedRowCount = runRowCount;
  // N (current row) is deliberately NOT computed client-side for this
  // launch: neither SSE log lines nor wall-clock ticks are reliable
  // signals. We'd rather show a row-less "Processing M rows..." label
  // (honest + useful) than a fake "row 3 of 5" that drifts off real
  // progress (codex review 2026-04-24). The ticking timer on the banner
  // still gives the user a live heartbeat. Real per-row N ships when
  // the server emits structured progress events (tracked separately).

  const handleInputChange = useCallback((name: string, value: unknown) => {
    setState((s) => {
      // Issue #256: editing a flagged field clears its inline error so
      // the red ring disappears as soon as the user types a valid value.
      let inputErrors = s.inputErrors;
      if (inputErrors && inputErrors[name]) {
        const { [name]: _dropped, ...rest } = inputErrors;
        inputErrors = Object.keys(rest).length === 0 ? undefined : rest;
      }
      return { ...s, inputs: { ...s.inputs, [name]: value }, inputErrors };
    });
  }, []);

  // Upgrade 2: swap to a different action tab. Clears any in-flight
  // run state so the new tab starts clean; preserves `hasRun` so the
  // Run → Refine flip (when refinable) persists across tab switches.
  const handleSelectAction = useCallback(
    (nextAction: string) => {
      const spec = app.manifest.actions[nextAction];
      if (!spec) return;
      setState((s) => ({
        ...s,
        phase: 'ready',
        action: nextAction,
        actionSpec: spec,
        inputs: buildInitialInputs(spec),
        runId: undefined,
        run: undefined,
        logs: undefined,
        job: undefined,
        jobId: undefined,
        errorMessage: undefined,
        inputErrors: undefined,
      }));
      onResetInitialRun?.();
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          // Keep the URL clean for the default action; any non-default
          // action stays explicit so it remains shareable.
          if (defaultEntry && nextAction === defaultEntry.action) {
            next.delete('action');
          } else {
            next.set('action', nextAction);
          }
          return next;
        },
        { replace: true },
      );
    },
    [app.manifest.actions, defaultEntry, onResetInitialRun, setSearchParams],
  );

  const handleReset = useCallback(() => {
    if (!defaultEntry) return;
    setState((s) => {
      // Upgrade 2 (2026-04-19): preserve the currently-selected action on
      // reset instead of snapping back to the first action. Users picking
      // a non-default tab and pressing Reset expect the same tab to stay.
      const currentSpec =
        (s.action && app.manifest.actions[s.action]) || defaultEntry.spec;
      const currentAction = s.action || defaultEntry.action;
      return {
        phase: 'ready',
        inputs: buildInitialInputs(currentSpec, initialInputs),
        action: currentAction,
        actionSpec: currentSpec,
        hasRun: s.hasRun,
      };
    });
    onResetInitialRun?.();
  }, [app.manifest.actions, defaultEntry, initialInputs, onResetInitialRun]);

  const handleRun = useCallback(async () => {
    if (state.phase !== 'ready' && state.phase !== 'done' && state.phase !== 'error') return;
    if (!defaultEntry) return;
    const action = state.action || defaultEntry.action;
    const actionSpec = state.actionSpec.inputs ? state.actionSpec : defaultEntry.spec;
    const inputs = coerceInputs(state.inputs, actionSpec);

    // Issue #256: pre-submit validation for required inputs. Avoids a
    // round-trip to the backend for the most common bad state (user
    // forgot to fill in a required field) and lets us render a clean
    // field-level error instead of the old "Missing required input: X"
    // panel. Server still validates — this is just a nicer first line
    // of defense.
    const missing = findMissingRequiredInputs(inputs, actionSpec);
    if (Object.keys(missing).length > 0) {
      setState((s) => ({ ...s, inputErrors: missing, phase: s.phase === 'error' ? 'ready' : s.phase }));
      // Scroll + focus the first flagged field so the user sees the fix
      // without hunting for it. Deferred a frame so the red ring has
      // rendered by the time we focus.
      const firstName = Object.keys(missing)[0];
      if (typeof window !== 'undefined') {
        requestAnimationFrame(() => {
          const el = document.getElementById(`run-surface-inp-${firstName}`);
          if (el) {
            el.focus({ preventScroll: false });
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        });
      }
      return;
    }

    // Clear shared-run hydration on explicit re-run.
    onResetInitialRun?.();

    // Snapshot the submitted payload for the run-banner row counter. We
    // pin it here (BEFORE the async startRun/startJob call resolves) so
    // any field edits the user makes in the short gap between click and
    // phase=streaming/job don't reshape M mid-flight (codex review
    // 2026-04-24). Cleared on terminal phase via the same effect.
    submittedPayloadRef.current = { inputs, spec: actionSpec };

    if (app.is_async) {
      try {
        const { job_id } = await api.startJob(app.slug, inputs, action);
        let stopPoll: (() => void) | null = null;
        setState((s) => ({
          ...s,
          phase: 'job',
          jobId: job_id,
          job: null,
        }));

        stopPoll = api.pollJob(app.slug, job_id, {
          onUpdate: (job) => {
            setState((s) => {
              if (s.phase !== 'job' || s.jobId !== job_id) return s;
              return { ...s, job };
            });
          },
          onDone: (job) => {
            const run = jobToRunRecord(job, action);
            setState((s) => ({
              ...s,
              phase: 'done',
              job,
              run,
              hasRun: true,
            }));
            // Issue #618: a finished job consumed a free-run slot on the
            // server (recordFreeRun fires synchronously at dispatch, before
            // this SSE/polling completion). Bump so FreeRunsStrip re-fetches
            // /api/:slug/quota and the counter drops from "5 of 5" to "4
            // of 5". No-op for non-gated slugs (the strip renders nothing).
            freeRunsRefresher.bump();
            if (typeof window !== 'undefined' && window.history?.replaceState) {
              try {
                const url = new URL(window.location.href);
                url.searchParams.set('job', job.id);
                window.history.replaceState(null, '', url.toString());
              } catch {
                /* ignore */
              }
            }
            onResult?.({
              runId: job.id,
              output: job.output ? JSON.stringify(job.output) : '',
              exitCode: job.status === 'succeeded' ? 0 : 1,
            });
          },
          onError: () => {
            /* transient; pollJob keeps ticking until stopped */
          },
        });

        setState((s) =>
          s.phase === 'job' && s.jobId === job_id
            ? { ...s, cancelPoll: stopPoll! }
            : s,
        );
      } catch (err) {
        const e = err as Error;
        const clientFieldError = parseClientFileError(e);
        if (clientFieldError) {
          setState((s) => ({ ...s, inputErrors: clientFieldError, phase: 'ready' }));
          focusFirstFlaggedField(Object.keys(clientFieldError)[0]);
          return;
        }
        const serverFieldError = parseMissingRequiredInput(e, actionSpec);
        if (serverFieldError) {
          setState((s) => ({ ...s, inputErrors: serverFieldError }));
          focusFirstFlaggedField(Object.keys(serverFieldError)[0]);
          return;
        }
        setState((s) => ({
          ...s,
          phase: 'error',
          errorMessage: getRunStartErrorMessage(e, 'Could not enqueue job'),
        }));
      }
      return;
    }

    try {
      const { run_id } = await api.startRun(app.slug, inputs, undefined, action);
      setState((s) => ({ ...s, phase: 'streaming', runId: run_id, logs: [] }));

      const close = api.streamRun(run_id, {
        onLog: (line) => {
          setState((s) => {
            if (s.phase !== 'streaming' || s.runId !== run_id) return s;
            return { ...s, logs: [...(s.logs ?? []), line.text] };
          });
        },
        onStatus: (run: RunRecord) => {
          if (!['success', 'error', 'timeout'].includes(run.status)) return;
          setState((s) => ({
            ...s,
            phase: 'done',
            run,
            hasRun: true,
          }));
          close();
          // Issue #618: the server already consumed a free-run slot at
          // POST /api/run dispatch time (recordFreeRun in routes/run.ts).
          // The strip would otherwise stay stuck at "5 of 5" for the whole
          // session because useFreeRunsRefresher was only bumped by the
          // BYOK modal. Bump on every terminal status so the counter
          // drops after each real run. No-op on non-gated slugs.
          freeRunsRefresher.bump();
          if (typeof window !== 'undefined' && window.history?.replaceState) {
            try {
              const url = new URL(window.location.href);
              url.searchParams.set('run', run.id);
              window.history.replaceState(null, '', url.toString());
            } catch {
              /* ignore */
            }
          }
          onResult?.({
            runId: run.id,
            output: run.outputs ? JSON.stringify(run.outputs) : '',
            exitCode: run.status === 'success' ? 0 : 1,
          });
        },
        onError: () => {
          /* polling fallback */
        },
      });
    } catch (err) {
      const e = err as Error;
      // BYOK gate: 429 byok_required → show key modal instead of a
      // dead-end error panel. onSaved will re-invoke handleRun, which
      // attaches the saved key via startRun's X-User-Api-Key header.
      if (
        e instanceof ApiError &&
        e.status === 429 &&
        e.payload &&
        typeof e.payload === 'object' &&
        (e.payload as { error?: string }).error === 'byok_required'
      ) {
        setByokPayload(e.payload as typeof byokPayload);
        setByokMode('exhausted');
        setByokOpen(true);
        setState((s) => ({ ...s, phase: s.hasRun ? 'done' : 'ready' }));
        return;
      }
      const clientFieldError = parseClientFileError(e);
      if (clientFieldError) {
        setState((s) => ({ ...s, inputErrors: clientFieldError, phase: 'ready' }));
        focusFirstFlaggedField(Object.keys(clientFieldError)[0]);
        return;
      }
      const serverFieldError = parseMissingRequiredInput(e, actionSpec);
      if (serverFieldError) {
        setState((s) => ({ ...s, inputErrors: serverFieldError }));
        focusFirstFlaggedField(Object.keys(serverFieldError)[0]);
        return;
      }
      setState((s) => ({
        ...s,
        phase: 'error',
        errorMessage: getRunStartErrorMessage(e, 'Run failed to start'),
      }));
    }
  }, [state, app.slug, app.is_async, defaultEntry, onResetInitialRun, onResult, freeRunsRefresher]);

  const handleCancelJob = useCallback(async () => {
    const s = state;
    if (s.phase !== 'job' || !s.jobId) return;
    try {
      s.cancelPoll?.();
      await api.cancelJob(app.slug, s.jobId);
    } catch {
      /* fall through to cancelled state */
    }
    setState((cur) => ({
      ...cur,
      phase: 'error',
      errorMessage: 'Job cancelled.',
    }));
  }, [state, app.slug]);

  const handleCancelStream = useCallback(() => {
    setState((s) => ({ ...s, phase: 'error', errorMessage: 'Run cancelled.' }));
  }, []);

  const appAsPickResult: PickResult = useMemo(
    () => ({
      slug: app.slug,
      name: app.name,
      description: app.description,
      category: app.category,
      icon: app.icon,
      confidence: 1,
    }),
    [app.slug, app.name, app.description, app.category, app.icon],
  );

  // Creator opt-out: manifest.render.render_hint === 'stacked' forces the
  // single-column layout regardless of viewport. Useful for apps whose
  // output is a wide preview (PDFs, dashboards) where the input card
  // would steal too much horizontal room.
  const renderHint = app.manifest?.render?.render_hint;
  const stacked = renderHint === 'stacked';

  // Refine UI is opt-in as of 2026-04-19 (previously default-on). Creators
  // declare `render.refinable: true` in seed.json / manifest to flip the
  // primary button to "Refine" after the first run AND to expose the
  // bottom "Iterate" free-text composer on OutputPanel. Apps that are
  // deterministic one-shots (uuid, hash, password, …) correctly stay
  // stuck on "Run" and hide the iterate box. Fix 2 (2026-04-19).
  const refinable =
    app.manifest?.render?.refinable === true && !isRefineSuppressedForApp(app);
  const runLabel = state.hasRun && refinable ? 'Refine' : 'Run';

  const hasInputs = (state.actionSpec?.inputs?.length ?? 0) > 0;

  // Shared-run banner visibility — see deriveSharedRunBanner() below for
  // the pure decision logic + stress test hook.
  const viewingSharedRun = deriveSharedRunBanner({
    initialRunId: initialRun?.id ?? null,
    currentRunId: state.runId ?? null,
    phase: state.phase,
  });

  return (
    <div
      className={`run-surface${stacked ? ' run-surface-stacked' : ''}`}
      data-testid="run-surface"
      data-phase={state.phase}
      data-has-refine={refinable ? 'true' : 'false'}
      data-has-iterate={refinable ? 'true' : 'false'}
    >
      {viewingSharedRun && (
        <div
          data-testid="shared-run-banner"
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            flexWrap: 'wrap',
            padding: '10px 14px',
            marginBottom: 16,
            background: 'var(--accent-soft, #ecfdf5)',
            border: '1px solid var(--accent-border, #86efac)',
            borderRadius: 10,
            fontSize: 13,
            color: 'var(--ink)',
          }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            <span
              aria-hidden="true"
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: 999,
                background: 'var(--accent, #10b981)',
              }}
            />
            Viewing a shared run.
          </span>
          <button
            type="button"
            data-testid="shared-run-try-yourself"
            onClick={handleReset}
            style={{
              padding: '6px 14px',
              borderRadius: 999,
              border: '1px solid var(--accent, #10b981)',
              background: 'var(--accent, #10b981)',
              color: '#fff',
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            Run this yourself &rarr;
          </button>
        </div>
      )}

      {/* Free-runs strip (2026-04-25): visible BYOK status for the 3
          launch demo slugs. Renders nothing for every other app, so it's
          safe to mount unconditionally. See FreeRunsStrip.tsx for the
          state-machine rationale (remaining / exhausted / user-key). */}
      <FreeRunsStrip
        slug={app.slug}
        refreshKey={freeRunsRefresher.refreshKey}
        onOpenBYOK={() => {
          setByokPayload({
            slug: app.slug,
            // Proactive-mode defaults — the modal's "exhausted" copy
            // keys off byokMode, not off payload numbers, so usage=0 /
            // limit=5 here are only used if the modal ever renders
            // numeric copy (it currently does not in proactive mode).
            usage: 0,
            limit: 5,
            get_key_url: 'https://aistudio.google.com/app/apikey',
          });
          setByokMode('proactive');
          setByokOpen(true);
        }}
      />

      {/* Upgrade 2 (2026-04-19): action tab strip for multi-action apps.
          Hidden on single-action apps to preserve the current layout.
          Each tab swaps the input card + POST target action. */}
      {hasMultipleActions && (
        <div
          role="tablist"
          aria-label="App actions"
          data-testid="run-surface-action-tabs"
          style={{
            display: 'flex',
            gap: 2,
            borderBottom: '1px solid var(--line)',
            marginBottom: 16,
            overflowX: 'auto',
          }}
        >
          {actionEntries.map(([name, spec]) => {
            const isOn = state.action === name;
            const isPrimary = primaryActionName === name;
            return (
              <button
                key={name}
                type="button"
                role="tab"
                aria-selected={isOn}
                data-testid={`run-surface-action-tab-${name}`}
                data-state={isOn ? 'active' : 'inactive'}
                data-primary={isPrimary ? 'true' : 'false'}
                onClick={() => handleSelectAction(name)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 16px',
                  fontSize: 13,
                  fontWeight: 600,
                  border: 'none',
                  // Subtle green tint on the primary tab (Fix 3) so it
                  // reads as "start here" without competing with the
                  // active-tab underline.
                  background: isPrimary ? 'var(--accent-soft, #ecfdf5)' : 'transparent',
                  color: isOn ? 'var(--accent)' : 'var(--muted)',
                  borderBottom: isOn ? '2px solid var(--accent)' : '2px solid transparent',
                  marginBottom: -1,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  whiteSpace: 'nowrap',
                }}
              >
                {spec.label || name}
                {isPrimary && (
                  <span
                    data-testid={`run-surface-action-tab-${name}-primary-pill`}
                    aria-label="Primary action"
                    style={{
                      padding: '2px 8px',
                      borderRadius: 999,
                      background: 'var(--accent, #10b981)',
                      color: '#fff',
                      fontSize: 10,
                      fontWeight: 700,
                      letterSpacing: '0.04em',
                      textTransform: 'uppercase',
                    }}
                  >
                    Primary
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* #626 v17 run banner + per-row stream feed — visible ONLY during
          streaming / job phases, never on the shared-run `done` path
          (PublicRunPermalinkPage always hydrates with phase=done). Guarded
          by the explicit phase check so no banner/feed ever renders for
          /r/:id permalinks. Styles live in globals.css (.run-banner,
          .run-feed, .run-feed-row) and mirror the wireframe's
          .run-banner + .stream-row blocks. */}
      {isRunning && (
        <>
          {/* Plain non-live region: assistive tech already gets phase
              changes from run-surface-output (aria-live="polite") and
              the InputCard's `running` prop. Re-announcing the timer
              every 1s would spam screen readers (codex [P3]
              2026-04-24). */}
          <div className="run-banner" data-testid="run-banner">
            <span className="run-banner-dot" aria-hidden="true" />
            <span className="run-banner-label">
              Running: <strong>{state.actionSpec.label || state.action || 'run'}</strong>
              ...
            </span>
            <span className="run-banner-meta mono">
              {formatElapsed(elapsedMs)}
            </span>
          </div>
          <div className="run-feed" data-testid="run-feed">
            <div className="run-feed-row" data-testid="run-feed-row">
              <span className="run-feed-idx mono" aria-hidden="true">
                {estimatedRowCount != null
                  ? `~${estimatedRowCount}`
                  : '—'}
              </span>
              <span className="run-feed-glyph" aria-hidden="true">
                <span className="run-feed-glyph-pulse" />
              </span>
              <span className="run-feed-name">
                {estimatedRowCount != null
                  ? `Processing ~${estimatedRowCount} ${estimatedRowCount === 1 ? 'row' : 'rows'}...`
                  : 'Processing...'}
              </span>
              <span className="run-feed-elapsed mono">
                {formatElapsed(elapsedMs)}
              </span>
            </div>
          </div>
        </>
      )}

      <div className="run-surface-grid">
        <section
          className="run-surface-input"
          data-testid="run-surface-input"
          aria-label="Input"
        >
          <InputCard
            app={appAsPickResult}
            actionSpec={state.actionSpec}
            inputs={state.inputs}
            inputErrors={state.inputErrors}
            runLabel={runLabel}
            running={state.phase === 'streaming' || state.phase === 'job'}
            // v23 PR-D (2026-04-26): InputCard mode flag drives the
            // 4-state visual treatment locked by Federico Delta 3:
            //   'edit'     — default editable form (idle / error / after Edit & rerun)
            //   'locked'   — fields readable, dimmed, submit shows Running…
            //   'recap'    — submitted values shown read-only, Run again / Edit & rerun CTAs
            //   'disabled' — quota exhausted, fields and submit greyed out
            // Input column is ALWAYS visible across phases per Delta 3.
            mode={
              state.phase === 'streaming' || state.phase === 'job'
                ? 'locked'
                : state.phase === 'done'
                  ? 'recap'
                  : state.phase === 'ready' && byokExhausted
                    ? 'disabled'
                    : 'edit'
            }
            runStartedAt={runStartedAt}
            onChange={handleInputChange}
            onRun={handleRun}
            onReset={handleReset}
            onEditRerun={() => {
              // "Edit & rerun" path: drop the run state back to ready
              // (re-enables fields) but KEEP the inputs so the user can
              // tweak them and re-submit. Distinct from full Reset
              // (which clears the inputs) and from Run again (which
              // re-submits the same inputs unmodified).
              setState((s) => ({
                ...s,
                phase: 'ready',
                run: undefined,
                runId: undefined,
                logs: undefined,
                errorMessage: undefined,
                inputErrors: undefined,
              }));
              onResetInitialRun?.();
            }}
            hasInputs={hasInputs}
          />
        </section>

        <section
          className="run-surface-output"
          data-testid="run-surface-output"
          aria-label="Output"
          aria-live="polite"
        >
          <OutputSlot
            app={app}
            appAsPickResult={appAsPickResult}
            state={state}
            refinable={refinable}
            byokExhausted={byokExhausted}
            quotaResetWindowMs={quotaResetWindowMs}
            onCancelJob={handleCancelJob}
            onCancelStream={handleCancelStream}
            onOpenBYOK={() => {
              setByokPayload({
                slug: app.slug,
                usage: 5,
                limit: 5,
                get_key_url: 'https://aistudio.google.com/app/apikey',
              });
              setByokMode('exhausted');
              setByokOpen(true);
            }}
            onIterate={(prompt) => {
              setState((s) => ({
                ...s,
                phase: 'ready',
                inputs: { ...s.inputs, prompt },
              }));
              onResetInitialRun?.();
            }}
            onRetry={handleRun}
          />
        </section>
      </div>

      <PastRunsDisclosure appSlug={app.slug} />

      <BYOKModal
        open={byokOpen}
        mode={byokMode}
        payload={byokPayload}
        onClose={() => {
          setByokOpen(false);
          // Refresh the strip so a cancelled proactive flow re-reads
          // the current localStorage state (no-op if nothing changed).
          freeRunsRefresher.bump();
        }}
        onSaved={() => {
          setByokOpen(false);
          freeRunsRefresher.bump();
          if (byokMode === 'exhausted') {
            // Exhausted flow → retry the run that just failed. In
            // proactive mode the user might only want to save the key
            // and start filling inputs; don't auto-launch a run.
            void handleRun();
          }
        }}
      />
    </div>
  );
}

// ── Input card ─────────────────────────────────────────────────────────────

interface InputCardProps {
  app: PickResult;
  actionSpec: ActionSpec;
  inputs: Record<string, unknown>;
  inputErrors?: Record<string, string>;
  runLabel: string;
  running: boolean;
  hasInputs: boolean;
  /**
   * v23 PR-D Delta 3 (2026-04-26): visual mode for the input card. The
   * column stays MOUNTED across every phase per Federico's locked
   * "input + output co-visible" rule; this flag picks the visual treatment.
   *   'edit'     — default editable form
   *   'locked'   — fields visible + readable but dimmed (running)
   *   'recap'    — values shown read-only with Run again / Edit & rerun (done)
   *   'disabled' — fields greyed out, submit unusable (quota exhausted)
   */
  mode: 'edit' | 'locked' | 'recap' | 'disabled';
  /**
   * Wall-clock start time of the in-flight run (locked mode only).
   * Used to render a small "Running for Xs" label inside the locked
   * input. Null when not running.
   */
  runStartedAt: number | null;
  onChange: (name: string, value: unknown) => void;
  onRun: () => void;
  onReset: () => void;
  /**
   * Recap-mode "Edit & rerun" handler: unlocks the fields back to edit
   * mode without resubmitting. Wired by RunSurface to drop the run state
   * back to phase='ready' while preserving the inputs.
   */
  onEditRerun: () => void;
}

function InputCard({
  app,
  actionSpec,
  inputs,
  inputErrors,
  runLabel,
  running,
  hasInputs,
  mode,
  runStartedAt,
  onChange,
  onRun,
  onReset,
  onEditRerun,
}: InputCardProps) {
  // Fix 5 (2026-04-19): progressive disclosure of optional inputs.
  // Required fields render inline, optional fields stay collapsed behind
  // a "Show N optional fields" toggle. Reduces form length on apps like
  // OpenSlides that have 1 required + 3 optional inputs.
  const [showOptional, setShowOptional] = useState(false);
  const { required, optional } = useMemo(() => {
    const req: typeof actionSpec.inputs = [];
    const opt: typeof actionSpec.inputs = [];
    for (const inp of actionSpec.inputs) {
      if (inp.required) req.push(inp);
      else opt.push(inp);
    }
    return { required: req, optional: opt };
  }, [actionSpec.inputs]);

  // v23 PR-D Delta 3 (2026-04-26): mode-driven visual treatment.
  //   'locked'   — fields visible + readable but de-emphasized; submit shows Running…
  //   'disabled' — fields greyed out (rate-limited; can't submit until BYOK)
  //   'recap'    — render the recap card branch below (early return)
  //   'edit'     — default editable form
  const lockedVisual = mode === 'locked';
  const disabledVisual = mode === 'disabled';
  const dimWrapStyle: React.CSSProperties =
    lockedVisual
      ? { opacity: 0.78, pointerEvents: 'none' }
      : disabledVisual
        ? { opacity: 0.55, pointerEvents: 'none' }
        : {};
  // INPUT eyebrow label per v23 wireframe — small mono uppercase token
  // above the form that names the column. In locked mode it gains a
  // "· SUBMITTED" suffix so the visitor sees what just happened.
  const inputEyebrow =
    lockedVisual ? 'INPUT · SUBMITTED' : disabledVisual ? 'INPUT · LIMIT REACHED' : 'INPUT';

  // Recap-mode branch. After a successful run the input column flips to
  // a read-only summary of what produced the output below, plus twin
  // CTAs: Run again (re-submit same inputs) and Edit & rerun (unlock
  // fields for tweaks). Decision doc §3.4.
  if (mode === 'recap' && hasInputs) {
    return (
      <div
        className="run-surface-card"
        data-testid="run-surface-input-card"
        data-mode="recap"
      >
        <div
          className="run-surface-input-eyebrow"
          data-testid="run-surface-input-eyebrow"
          style={{
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            fontSize: 10.5,
            color: 'var(--muted)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontWeight: 600,
            marginBottom: 12,
          }}
        >
          INPUT · SUBMITTED
        </div>
        <div
          className="run-surface-recap-fields"
          data-testid="run-surface-recap-fields"
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
        >
          {actionSpec.inputs.map((inp) => {
            const raw = inputs[inp.name];
            const display = formatRecapValue(raw);
            if (display == null) return null;
            return (
              <div
                key={inp.name}
                data-testid={`run-surface-recap-${inp.name}`}
                style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}
              >
                <span
                  style={{
                    fontSize: 11,
                    color: 'var(--muted)',
                    fontWeight: 600,
                  }}
                >
                  {inp.label || inp.name}
                </span>
                <span
                  style={{
                    fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                    fontSize: 13,
                    color: 'var(--ink)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                  title={display}
                >
                  {display}
                </span>
              </div>
            );
          })}
        </div>
        <div className="run-surface-actions" style={{ marginTop: 18 }}>
          <button
            type="button"
            className="btn-primary"
            data-testid="run-surface-run-again-btn"
            onClick={onRun}
            style={{ height: 44, minHeight: 44, padding: '0 22px', fontSize: 15 }}
          >
            Run again
            <RunArrow />
          </button>
          <button
            type="button"
            className="btn-ghost"
            data-testid="run-surface-edit-rerun-btn"
            onClick={onEditRerun}
          >
            Edit & rerun
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="run-surface-card"
      data-testid="run-surface-input-card"
      data-mode={mode}
    >
      {/* v23 PR-D: small "INPUT" mono eyebrow above the form. Picks up a
          "· SUBMITTED" suffix in locked mode so the running state reads
          as "this is what we just sent" (Federico Delta 3). */}
      <div
        className="run-surface-input-eyebrow"
        data-testid="run-surface-input-eyebrow"
        style={{
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 10.5,
          color: 'var(--muted)',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
          fontWeight: 600,
          marginBottom: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <span>{inputEyebrow}</span>
        {lockedVisual && runStartedAt != null && (
          <RunningEyebrowTimer startedAt={runStartedAt} />
        )}
      </div>
      {hasInputs ? (
        <form
          style={dimWrapStyle}
          aria-disabled={lockedVisual || disabledVisual}
          onSubmit={(e) => {
            e.preventDefault();
            if (!running && !disabledVisual) onRun();
          }}
        >
          <div className="run-surface-fields" data-testid="run-surface-fields-required">
            {required.map((inp) => (
              <InputField
                key={inp.name}
                spec={inp}
                value={inputs[inp.name]}
                onChange={(v) => onChange(inp.name, v)}
                idPrefix="run-surface-inp"
                error={inputErrors?.[inp.name]}
                appSlug={app.slug}
              />
            ))}
          </div>
          {optional.length > 0 && (
            <>
              {/* Issue #89 (2026-04-23): optional fields are now a proper
                  toggle. Pre-fix the disclosure only expanded; clicking it
                  again after expand did nothing, so users had no way to
                  hide the optional block once opened. The same button now
                  flips between "Show N optional fields" and "Hide N
                  optional fields" based on state. */}
              <button
                type="button"
                data-testid="run-surface-show-optional"
                aria-expanded={showOptional}
                aria-controls="run-surface-fields-optional"
                onClick={() => setShowOptional((v) => !v)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  marginTop: 8,
                  /* Tap-target fix (2026-04-23, issue #562):
                     the disclosure was 6px + 13px font + 6px = ~28px
                     tall, below the WCAG 2.5.5 minimum of 44px. Bump
                     vertical padding and min-height so the touch
                     surface is reliable; widen horizontal padding so
                     the arrow and label don't hug the edge. */
                  padding: '10px 8px',
                  minHeight: 44,
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--muted)',
                  fontSize: 13,
                  fontWeight: 500,
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                }}
              >
                {showOptional ? 'Hide' : 'Show'} {optional.length} optional field
                {optional.length === 1 ? '' : 's'}{' '}
                <span aria-hidden="true">{showOptional ? '\u2191' : '\u2192'}</span>
              </button>
              {showOptional && (
                <div
                  id="run-surface-fields-optional"
                  className="run-surface-fields"
                  data-testid="run-surface-fields-optional"
                  style={{ marginTop: 8 }}
                >
                  {optional.map((inp) => (
                    <InputField
                      key={inp.name}
                      spec={inp}
                      value={inputs[inp.name]}
                      onChange={(v) => onChange(inp.name, v)}
                      idPrefix="run-surface-inp"
                      error={inputErrors?.[inp.name]}
                      appSlug={app.slug}
                    />
                  ))}
                </div>
              )}
            </>
          )}
          {inputErrors && Object.keys(inputErrors).length > 0 && (
            <div
              role="alert"
              data-testid="run-surface-input-summary"
              className="run-surface-input-summary"
            >
              {Object.values(inputErrors)[0]}
            </div>
          )}
          <div className="run-surface-actions">
            {/* a11y 2026-04-20: aria-busy + aria-disabled announce "busy"
                during an active run. Spinner icon is aria-hidden so the
                label ("Running…" / "Run") is the only thing SRs read.
                v23 PR-D: in disabled mode (rate-limited) the button reads
                "Run (limit reached)" and stays unclickable — quota
                upsell sits in the output slot, not here. */}
            <button
              type="submit"
              className="btn-primary"
              data-testid="run-surface-run-btn"
              aria-busy={running}
              aria-disabled={running || disabledVisual}
              disabled={running || disabledVisual}
              style={{ height: 44, minHeight: 44, padding: '0 24px', fontSize: 15 }}
            >
              {running ? (
                <>
                  <RunSpinner />
                  <span>Running…</span>
                </>
              ) : disabledVisual ? (
                <span>Run (limit reached)</span>
              ) : (
                <>
                  {runLabel}
                  <RunArrow />
                </>
              )}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={onReset}
              disabled={running || disabledVisual}
            >
              Reset
            </button>
          </div>
        </form>
      ) : (
        <div className="run-surface-empty-input" style={dimWrapStyle}>
          <p className="run-surface-empty-copy">
            {mode === 'recap'
              ? `Result generated. Click ${runLabel} to generate another.`
              : `This app takes no input. Click ${runLabel} to generate.`}
          </p>
          <div className="run-surface-actions">
            <button
              type="button"
              className="btn-primary"
              data-testid="run-surface-run-btn"
              aria-busy={running}
              aria-disabled={running || disabledVisual}
              onClick={onRun}
              disabled={running || disabledVisual}
              style={{ height: 44, minHeight: 44, padding: '0 28px', fontSize: 15 }}
            >
              {running ? (
                <>
                  <RunSpinner />
                  <span>Running…</span>
                </>
              ) : disabledVisual ? (
                <span>Run (limit reached)</span>
              ) : (
                <>
                  {runLabel}
                  <RunArrow />
                </>
              )}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RunArrow() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: 14, height: 14, marginLeft: 6 }}
      aria-hidden="true"
    >
      <path d="M5 3l6 5-6 5V3z" fill="currentColor" />
    </svg>
  );
}

/**
 * Loading spinner rendered inline in the Run button during an active run.
 * aria-hidden so SRs don't see "image"; the sibling "Running…" span is
 * the announced label. Animated via inline @keyframes injected into
 * .run-spinner — see globals.css for the rotation keyframes.
 */
function RunSpinner() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: 14, height: 14, marginRight: 8 }}
      className="run-spinner"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path
        d="M14 8a6 6 0 0 0-6-6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * v23 PR-D Delta 3 helper: render a submitted input value as a single
 * line of recap text. Files surface as `name (size)`, arrays as a
 * comma-joined preview, plain primitives as themselves. Returns null
 * for empty / unset values so empty optional fields are skipped from
 * the recap card entirely (clean visual, no `(empty)` filler).
 */
export function formatRecapValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length === 0 ? null : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    const head = value
      .slice(0, 3)
      .map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      .join(', ');
    return value.length > 3 ? `${head}, +${value.length - 3} more` : head;
  }
  if (typeof File !== 'undefined' && value instanceof File) {
    const kb = Math.round(value.size / 1024);
    return `${value.name} (${kb} KB)`;
  }
  if (typeof value === 'object') {
    try {
      const json = JSON.stringify(value);
      return json.length > 80 ? `${json.slice(0, 77)}…` : json;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * v23 PR-D Delta 3 helper: small live-ticking timer rendered next to the
 * "INPUT · SUBMITTED" eyebrow during the running state. Uses the same
 * formatElapsed() format as the run-banner so the two timers on screen
 * agree. Updates once per second. Aria-hidden — the run-banner already
 * announces elapsed time to assistive tech.
 */
function RunningEyebrowTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const elapsed = Math.max(0, now - startedAt);
  return (
    <span
      aria-hidden="true"
      style={{
        fontFamily: 'JetBrains Mono, ui-monospace, monospace',
        fontSize: 10.5,
        fontWeight: 600,
        color: 'var(--accent, #047857)',
      }}
    >
      {formatElapsed(elapsed)}
    </span>
  );
}

// ── Output slot ────────────────────────────────────────────────────────────

interface OutputSlotProps {
  app: AppDetail;
  appAsPickResult: PickResult;
  state: RunState;
  refinable: boolean;
  /**
   * v23 PR-D (2026-04-26): true when the gated quota for this slug is
   * empty AND the visitor doesn't have a saved Gemini key. Drives the
   * inline RateLimitedCard render path on phase==='ready'. Already-done
   * runs render their output regardless of quota (decision doc §7.2).
   */
  byokExhausted: boolean;
  /**
   * Quota window length in ms (e.g. 86_400_000 for 24h). Today the API
   * returns no `resets_at`; we surface a static "Resets at midnight UTC"
   * fallback when the meter renders. Reserved for a future API delta —
   * console.warn to make a missing field visible to maintainers.
   */
  quotaResetWindowMs: number | null;
  /**
   * Open the BYOK modal in 'exhausted' mode. RateLimitedCard's "Add
   * your Gemini key" CTA wires here; the modal is the same one the
   * existing 429 fallback path uses.
   */
  onOpenBYOK: () => void;
  onCancelJob: () => void;
  onCancelStream: () => void;
  onIterate: (prompt: string) => void;
  /**
   * Error taxonomy (2026-04-20): called when the error card renders a
   * "Try again" button (upstream_outage class). Resubmits the same
   * inputs. RunSurface wires this to its top-level handleRun.
   */
  onRetry: () => void;
}

function OutputSlot({
  app,
  appAsPickResult,
  state,
  refinable,
  byokExhausted,
  quotaResetWindowMs,
  onOpenBYOK,
  onCancelJob,
  onCancelStream,
  onIterate,
  onRetry,
}: OutputSlotProps) {
  if (state.phase === 'ready') {
    if (byokExhausted) {
      return (
        <RateLimitedCard
          appName={app.name}
          slug={app.slug}
          windowMs={quotaResetWindowMs}
          onOpenBYOK={onOpenBYOK}
        />
      );
    }
    return (
      <EmptyOutputCard
        slug={app.slug}
        appName={app.name}
        actionSpec={state.actionSpec}
      />
    );
  }

  if (state.phase === 'streaming') {
    return (
      <StreamingTerminal
        app={appAsPickResult}
        lines={state.logs ?? []}
        onCancel={onCancelStream}
      />
    );
  }

  if (state.phase === 'job') {
    return (
      <JobProgress
        app={appAsPickResult}
        job={state.job ?? null}
        onCancel={onCancelJob}
      />
    );
  }

  if (state.phase === 'error') {
    // Issue #358: the pre-run error path (submit failed, network down,
    // 4xx from validation that slipped past the client, etc.) used to
    // render as a raw two-line card. Non-devs couldn't tell what to do
    // next. FriendlyStartupError maps the raw message to a human line,
    // offers a Try again button, and tucks the raw text into a
    // collapsed "Show details" disclosure on a light background.
    return (
      <FriendlyStartupError
        rawMessage={state.errorMessage || 'Try again.'}
        runId={state.runId}
        onRetry={onRetry}
      />
    );
  }

  // phase === 'done'
  if (!state.run) return null;

  // Hide the bottom "Iterate" composer when refinable is not opted in.
  // OutputPanel renders the Iterate row iff onIterate is truthy, so
  // passing undefined cleanly hides both the label and the input.
  const iterateHandler = refinable ? onIterate : undefined;

  if (app.renderer) {
    return (
      <CustomRendererHost
        slug={app.slug}
        run={state.run}
        sourceHash={app.renderer.source_hash}
      >
        <OutputPanel
          app={appAsPickResult}
          appDetail={app}
          run={state.run}
          onIterate={iterateHandler}
          onRetry={onRetry}
        />
      </CustomRendererHost>
    );
  }

  return (
    <OutputPanel
      app={appAsPickResult}
      appDetail={app}
      run={state.run}
      onIterate={iterateHandler}
      onRetry={onRetry}
    />
  );
}

function EmptyOutputCard({
  slug,
  appName,
  actionSpec,
}: {
  slug: string;
  appName: string;
  actionSpec: ActionSpec;
}) {
  // Pre-run empty state. Federico audit 2026-04-24: the right-side
  // output panel used to read as dead space — title was the literal
  // first output label (e.g. "Total Rows will appear here" for Lead
  // Scorer, because `outputs[0]` is a scalar counter, not the real
  // ranked table). We now:
  //
  //   1. Pick the HERO output for title/hint — first `table` / `json`
  //      / `markdown` / `html` output if present, else fall back to
  //      outputs[0]. This gives Lead Scorer "Scored Leads" instead of
  //      "Total Rows", which actually describes what the user is
  //      about to get.
  //   2. If the app has a curated SampleOutputPreview entry (hero apps:
  //      lead-scorer, resume-screener, competitor-analyzer), render
  //      that instead of the generic skeleton. Sample shows the SHAPE
  //      of real output (columns, example rows) in muted monospace,
  //      clearly labeled "example output · not yours". This is what
  //      Federico asked for — "app visuals could show on the right
  //      side".
  //   3. Copy shifts to proposal tone — "Your result will look like
  //      this" (matches wireframe app-page.html line 358) when we have
  //      a sample, keeps the previous "Output will appear here" copy
  //      otherwise.
  //   4. Type-specific skeleton still fires for apps without a curated
  //      sample: 3-row dashed table for table outputs, 3 stacked lines
  //      for text/markdown/html, a `{ }` shell for json.
  const heroOutput = pickHeroOutput(actionSpec);
  const outputLabel = heroOutput?.label || 'Output';
  const hasSample = hasSampleForSlug(slug);
  const outputHint = hasSample
    ? 'This is what your real result will look like once you press Run.'
    : heroOutput?.description?.trim() ||
      `Fill in the form and press Run to generate a result with ${appName}.`;
  const title = hasSample
    ? 'Your result will look like this'
    : `${outputLabel} will appear here`;
  return (
    <div
      className="run-surface-card run-surface-empty-output"
      data-testid="run-surface-empty-output"
    >
      <div className="run-surface-empty-output-inner">
        <div className="run-surface-empty-output-title">{title}</div>
        <div className="run-surface-empty-output-sub">{outputHint}</div>
        {hasSample ? (
          <div style={{ marginTop: 18 }}>
            <SampleOutputPreview slug={slug} />
          </div>
        ) : (
          <EmptyOutputSkeleton outputType={heroOutput?.type} />
        )}
      </div>
    </div>
  );
}

/**
 * Pick the "hero" output from an action spec — the one the user cares
 * about, which is almost always the richest container type (table /
 * json / markdown / html) rather than a scalar counter that happens to
 * sit at outputs[0]. Falls back to outputs[0] when no container output
 * exists (utility apps like uuid / hash return a single string).
 */
function pickHeroOutput(
  actionSpec: ActionSpec,
): ActionSpec['outputs'][number] | undefined {
  const rich = actionSpec.outputs.find((o) =>
    o.type === 'table' ||
    o.type === 'json' ||
    o.type === 'markdown' ||
    o.type === 'html',
  );
  return rich ?? actionSpec.outputs[0];
}

/**
 * Faint, non-interactive skeleton that hints at the shape of the
 * upcoming run output. Purely presentational — role=presentation so
 * screen readers skip it (the copy above already describes the slot).
 */
function EmptyOutputSkeleton({ outputType }: { outputType: OutputType | undefined }) {
  const commonWrap: React.CSSProperties = {
    marginTop: 18,
    opacity: 0.55,
    pointerEvents: 'none',
  };
  if (outputType === 'table') {
    // v17 app-page.html alignment (2026-04-25): the wireframe shows a
    // real <table> preview — a faint header band (upper-case micro-copy),
    // five body rows with animated-looking skeleton "bars" of varying
    // widths. Previous version used a 3×3 grid of em-dashes which read
    // as "data not yet loaded" rather than "here's the SHAPE of what
    // you'll get". We don't know the real column names at this stage
    // (OutputSpec has no `columns` field), so the header row uses
    // generic "Result" / "Score" labels as visual placeholders. The
    // bar widths mirror the wireframe (80% / 65% / 72% / 58%) so the
    // mock looks hand-crafted, not programmatically uniform.
    const rowWidths = ['100%', '80%', '65%', '72%', '58%'];
    const thStyle: React.CSSProperties = {
      padding: '7px 10px',
      borderBottom: '1px solid var(--line)',
      textAlign: 'left',
      fontSize: 10,
      fontWeight: 600,
      color: 'var(--muted)',
      textTransform: 'uppercase',
      letterSpacing: '0.06em',
      background: 'var(--bg)',
    };
    const tdSkel: React.CSSProperties = {
      padding: '8px 10px',
      borderBottom: '1px solid var(--line)',
    };
    const barStyle: React.CSSProperties = {
      display: 'inline-block',
      height: 9,
      borderRadius: 4,
      background: 'var(--line)',
    };
    return (
      <div
        role="presentation"
        style={{
          ...commonWrap,
          border: '1px solid var(--line)',
          borderRadius: 10,
          overflow: 'hidden',
          background: 'var(--card)',
        }}
      >
        <table
          style={{
            width: '100%',
            borderCollapse: 'collapse',
            fontSize: 12,
          }}
        >
          <thead>
            <tr>
              <th style={thStyle}>Result</th>
              <th style={{ ...thStyle, width: 60, textAlign: 'right' }}>
                Score
              </th>
            </tr>
          </thead>
          <tbody>
            {rowWidths.map((w, i) => (
              <tr key={i}>
                <td
                  style={{
                    ...tdSkel,
                    // Last row omits the bottom border to match the wireframe's
                    // flush-to-the-table-edge look.
                    borderBottom:
                      i === rowWidths.length - 1 ? 'none' : tdSkel.borderBottom,
                  }}
                >
                  <span style={{ ...barStyle, width: w }} />
                </td>
                <td
                  style={{
                    ...tdSkel,
                    textAlign: 'right',
                    borderBottom:
                      i === rowWidths.length - 1 ? 'none' : tdSkel.borderBottom,
                  }}
                >
                  <span style={{ ...barStyle, width: 32 }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (outputType === 'json') {
    return (
      <pre
        role="presentation"
        style={{
          ...commonWrap,
          padding: '10px 12px',
          border: '1px dashed var(--line)',
          borderRadius: 8,
          background: 'var(--card, transparent)',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 12,
          color: 'var(--muted)',
          whiteSpace: 'pre-wrap',
          margin: 0,
        }}
      >
        {'{\n  …\n}'}
      </pre>
    );
  }
  // text / markdown / html / number / image / file — render three stacked
  // faded bars that approximate a block of generated prose. Good enough
  // as a "something will show up here" cue without committing to a shape
  // that the real output will not match.
  const barWidths = ['92%', '78%', '54%'];
  return (
    <div role="presentation" style={{ ...commonWrap, display: 'grid', gap: 8 }}>
      {barWidths.map((w, i) => (
        <div
          key={i}
          style={{
            height: 10,
            width: w,
            borderRadius: 999,
            background: 'var(--line)',
          }}
        />
      ))}
    </div>
  );
}

// ── Rate-limited inline upsell (v23 PR-D Delta 11) ─────────────────────────
//
// When a gated launch slug's free-run budget is exhausted AND the visitor
// has no saved Gemini key, the output column flips from EmptyOutputCard to
// RateLimitedCard. This is the inline counterpart to BYOKModal — visible
// without an extra click, with all three escape paths (BYOK / signup /
// self-host) shown side-by-side. Federico-locked decisions baked in:
//   - Single neutral palette (var(--card) bg, var(--line) border).
//     NO category tints, NO warm-dark `--code` background despite the
//     v23 wireframe — Federico's prompt overrides: "single neutral palette".
//   - Vocabulary: "BYOK key" + "Gemini key" — never "API key".
//   - NO "Upgrade to Pro" CTA — Pro doesn't exist pre-launch.
//   - The static "Resets at midnight UTC" reset line is a fallback because
//     /api/:slug/quota does not currently expose `resets_at`. If the API
//     gains that field later, surface the live timer here.

function RateLimitedCard({
  appName,
  slug: _slug,
  windowMs,
  onOpenBYOK,
}: {
  appName: string;
  slug: string;
  windowMs: number | null;
  onOpenBYOK: () => void;
}) {
  // The decision doc flagged a missing `resets_at` field on the quota
  // response. Until the API ships it we render a static reset hint
  // ("Resets at midnight UTC") and emit a console.warn so the gap is
  // visible to maintainers when the card mounts. window_ms is honored
  // when present, but it's a window length, not a wall-clock reset, so
  // we only show it as supplemental detail.
  useEffect(() => {
    if (windowMs == null) {
      // eslint-disable-next-line no-console
      console.warn(
        '[RateLimitedCard] quota response had no window_ms / resets_at; falling back to static reset copy',
      );
    }
  }, [windowMs]);

  const cardStyle: React.CSSProperties = {
    background: 'var(--card)',
    border: '1px solid var(--line)',
    borderRadius: 12,
    padding: '22px 22px 20px',
    minHeight: 280,
  };

  return (
    <div
      className="run-surface-card"
      data-testid="run-surface-rate-limited"
      style={cardStyle}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 36,
            height: 36,
            borderRadius: 9,
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--muted)',
            flexShrink: 0,
          }}
        >
          {/* clock glyph — neutral, not alarmist (Federico Delta 11) */}
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </svg>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h3
            style={{
              fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
              fontWeight: 700,
              fontSize: 17,
              letterSpacing: '-0.01em',
              lineHeight: 1.3,
              margin: '0 0 4px',
              color: 'var(--ink)',
            }}
          >
            You've used today's free runs.
          </h3>
          <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)', lineHeight: 1.55 }}>
            Floom covers 5 free runs per day on {appName}. Pick one of the
            options below to keep going right now.
          </p>
        </div>
      </div>

      {/* Meter — full bar so the visitor immediately sees "yes, used up". */}
      <div
        data-testid="run-surface-rate-limited-meter"
        style={{
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 10,
          padding: '12px 14px',
          marginBottom: 16,
        }}
      >
        <div
          style={{
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            fontSize: 10.5,
            color: 'var(--muted)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontWeight: 600,
            marginBottom: 8,
          }}
        >
          Today's usage
        </div>
        <div
          style={{
            height: 8,
            background: 'var(--line)',
            borderRadius: 999,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: '100%',
              background: 'var(--accent, #047857)',
            }}
          />
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 8,
            fontFamily: 'JetBrains Mono, ui-monospace, monospace',
            fontSize: 11.5,
            color: 'var(--muted)',
          }}
        >
          <span>
            <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>5 / 5</strong> runs used
          </span>
          <span>Resets at midnight UTC</span>
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {/* Recommended: paste your own Gemini key. Accent fill so it's the
            obvious primary action; opens the existing BYOKModal so the
            user-facing flow is identical to the post-429 fallback path. */}
        <button
          type="button"
          data-testid="run-surface-rate-limited-byok"
          onClick={onOpenBYOK}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 14px',
            border: '1px solid var(--accent, #047857)',
            background: 'var(--accent, #047857)',
            color: '#fff',
            borderRadius: 10,
            cursor: 'pointer',
            fontFamily: 'inherit',
            textAlign: 'left',
            width: '100%',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: 'rgba(255,255,255,0.18)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zM21 2l-9.6 9.6M15.5 7.5l3 3" />
            </svg>
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: 13.5,
                fontWeight: 600,
                color: '#fff',
              }}
            >
              Add your Gemini key for unlimited runs
            </span>
            <span
              style={{
                display: 'block',
                fontSize: 11.5,
                color: 'rgba(255,255,255,0.85)',
                marginTop: 2,
                lineHeight: 1.5,
              }}
            >
              Free key from Google AI Studio. Stays in your browser, never
              logged on Floom.
            </span>
          </span>
          <span
            aria-hidden="true"
            style={{
              color: '#fff',
              fontFamily: 'JetBrains Mono, ui-monospace, monospace',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              fontWeight: 700,
              background: 'rgba(255,255,255,0.18)',
              padding: '3px 8px',
              borderRadius: 999,
              fontSize: 9.5,
              flexShrink: 0,
            }}
          >
            Recommended
          </span>
        </button>

        {/* Self-host fallback — link to docs/SELF_HOST.md. Federico's prompt
            removed "Upgrade to Pro" so the secondary slot is split between
            "self-host" and the optional sign-in (rendered via existing
            top-bar). Sign-in is not duplicated here because it's already
            in the global top-bar; surfacing it twice would crowd the card
            and the v23 wireframe also keeps it discreet. */}
        <a
          href="https://github.com/floomhq/floom/blob/main/docs/SELF_HOST.md"
          target="_blank"
          rel="noreferrer"
          data-testid="run-surface-rate-limited-self-host"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            padding: '12px 14px',
            border: '1px solid var(--line)',
            background: 'var(--card)',
            color: 'var(--ink)',
            borderRadius: 10,
            textDecoration: 'none',
            fontFamily: 'inherit',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 28,
              height: 28,
              borderRadius: 7,
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
              color: 'var(--muted)',
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="2" y="6" width="20" height="12" rx="2" />
              <path d="M6 11h.01M10 11h.01M14 11h.01" />
            </svg>
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <span
              style={{
                display: 'block',
                fontSize: 13.5,
                fontWeight: 600,
                color: 'var(--ink)',
              }}
            >
              Self-host Floom
            </span>
            <span
              style={{
                display: 'block',
                fontSize: 11.5,
                color: 'var(--muted)',
                marginTop: 2,
                lineHeight: 1.5,
              }}
            >
              Run this app on your own infra with your own keys. MIT-licensed.
            </span>
          </span>
          <span aria-hidden="true" style={{ color: 'var(--muted)' }}>→</span>
        </a>
      </div>

      <p
        style={{
          margin: '14px 0 0',
          paddingTop: 14,
          borderTop: '1px solid var(--line)',
          fontFamily: 'JetBrains Mono, ui-monospace, monospace',
          fontSize: 11,
          color: 'var(--muted)',
          lineHeight: 1.55,
        }}
      >
        <strong style={{ color: 'var(--ink)', fontWeight: 600 }}>Or wait it out.</strong>{' '}
        Free runs reset every day at midnight UTC. Come back tomorrow.
      </p>
    </div>
  );
}

// ── Friendly pre-run error card (Issue #358) ────────────────────────────────
//
// When a run can't even start (network error, server 4xx, validation miss,
// BYOK-but-no-key, cancel-before-stream) we land in phase=='error' and used
// to render a raw "Something went wrong / <raw message>" card. For non-devs
// that felt broken — and the raw error text was often unreadable.
// humanizeStartupError() reduces common server/network patterns to a single
// human sentence, and FriendlyStartupError wraps it with a Try again button
// plus a collapsed "Show details" disclosure for the raw text.

/**
 * Reduce a raw pre-run error message to a one-line, non-technical summary.
 * Intentionally pattern-based (regex on the original message) so new server
 * shapes don't require a sweeping client update. Falls through to a generic
 * "We couldn't start the run" when no pattern matches.
 */
export function humanizeStartupError(raw: string): {
  headline: string;
  sub: string;
} {
  const r = (raw || '').toLowerCase();
  if (!r.trim()) {
    return {
      headline: "We couldn't start the run.",
      sub: 'Try again in a moment.',
    };
  }
  if (/cancel/.test(r)) {
    return {
      headline: 'Run cancelled.',
      sub: 'Press Run when you want to try again.',
    };
  }
  if (/timeout|timed out/.test(r)) {
    return {
      headline: "That took too long to start.",
      sub: 'The service may be warming up. Try again in a moment.',
    };
  }
  if (/network|fetch|offline|ECONN|failed to fetch/i.test(raw)) {
    // Audit 2026-04-24: softened from "Check your connection and try again."
    // On Render free-tier cold starts this message fires even when the
    // user's connection is fine — the API is just waking up.
    return {
      headline: "We couldn't reach the server.",
      sub: 'It might be waking up. Wait a few seconds, then Run again.',
    };
  }
  if (/rate[- ]?limit|429/.test(r)) {
    return {
      headline: 'Too many runs at once.',
      sub: 'Wait a few seconds and try again.',
    };
  }
  if (/byok|api key|gemini|auth/.test(r)) {
    return {
      headline: 'The run needs a Gemini API key.',
      sub: 'Add your key in settings, or try a different app.',
    };
  }
  if (/missing|required|invalid input|field/.test(r)) {
    return {
      headline: 'Something in the form needs a value.',
      sub: 'Check the highlighted field and try again.',
    };
  }
  if (/500|502|503|504|outage|upstream/.test(r)) {
    return {
      headline: "The server hiccuped.",
      sub: "This isn't your fault. Try again in a moment.",
    };
  }
  return {
    headline: "We couldn't start the run.",
    sub: 'Try again, or open details to see the raw error.',
  };
}

function FriendlyStartupError({
  rawMessage,
  runId,
  onRetry,
}: {
  rawMessage: string;
  /**
   * v23 PR-D: when the run actually got far enough to mint an id (e.g.
   * the SSE stream returned an error mid-flight rather than failing at
   * dispatch), surface a "View full run log" link to /me/runs/:id so
   * authenticated owners can inspect the logs server-side. Optional —
   * pre-dispatch failures land here without an id.
   */
  runId?: string;
  onRetry: () => void;
}) {
  const { headline, sub } = humanizeStartupError(rawMessage);
  return (
    <div
      className="run-surface-card run-surface-error-card"
      data-testid="run-surface-error"
      role="alert"
    >
      <p className="run-surface-error-title">{headline}</p>
      <p className="run-surface-error-body">{sub}</p>
      <div className="run-surface-error-actions">
        <button
          type="button"
          className="run-surface-error-retry"
          data-testid="run-surface-error-retry"
          onClick={onRetry}
        >
          Try again
        </button>
        {runId && (
          <Link
            to={`/me/runs/${runId}`}
            data-testid="run-surface-error-view-log"
            style={{
              fontSize: 13,
              color: 'var(--muted)',
              textDecoration: 'none',
              padding: '0 4px',
            }}
          >
            View full run log &rarr;
          </Link>
        )}
      </div>
      {/* v23 PR-D: gentle help line. Lists the most common causes the
          launch demos surface (URL fetch failures, blocked sites, model
          hiccups) so non-devs have a starting point without diving into
          the raw error. */}
      <p
        className="run-surface-error-help"
        data-testid="run-surface-error-help"
        style={{
          margin: '10px 0 0',
          fontSize: 12.5,
          color: 'var(--muted)',
          lineHeight: 1.5,
        }}
      >
        Common causes: typo in the URL, the site is offline, or it blocks
        programmatic access.
      </p>
      {rawMessage && rawMessage !== sub && (
        <details
          className="run-surface-error-details"
          data-testid="run-surface-error-details"
        >
          <summary className="run-surface-error-details-summary">
            Show details
          </summary>
          <pre className="run-surface-error-details-pre">{rawMessage}</pre>
        </details>
      )}
    </div>
  );
}

// ── Past runs disclosure ───────────────────────────────────────────────────

function PastRunsDisclosure({ appSlug }: { appSlug: string }) {
  const { isAuthenticated } = useSession();
  const deployEnabled = useDeployEnabled();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [runs, setRuns] = useState<MeRunSummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const loginHref = useMemo(
    () => `/login?next=${encodeURIComponent(location.pathname + location.search)}`,
    [location.pathname, location.search],
  );

  useEffect(() => {
    if (!open || !isAuthenticated || runs !== null) return;
    let cancelled = false;
    setLoading(true);
    api
      .getMyRuns(50)
      .then((res) => {
        if (cancelled) return;
        setRuns(res.runs.filter((r) => r.app_slug === appSlug));
      })
      .catch(() => {
        if (!cancelled) setRuns([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, isAuthenticated, runs, appSlug]);

  if (!isAuthenticated) {
    return (
      <details
        className="run-surface-past"
        data-testid="run-surface-past"
        onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      >
        <summary className="run-surface-past-summary">Earlier runs</summary>
        <div className="run-surface-past-body">
          {deployEnabled === true ? (
            <div className="run-surface-past-hint">
              Sign in to see your run history.{' '}
              <Link to={loginHref} data-testid="run-surface-past-signin-link">
                → Sign in
              </Link>
            </div>
          ) : (
            <div className="run-surface-past-hint">
              Run history is saved when you join Floom Cloud.{' '}
              <Link
                to={waitlistHref('runs-history')}
                data-testid="run-surface-past-waitlist-link"
              >
                → Join the waitlist
              </Link>
            </div>
          )}
        </div>
      </details>
    );
  }

  return (
    <details
      className="run-surface-past"
      data-testid="run-surface-past"
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
      <summary className="run-surface-past-summary">Earlier runs</summary>
      <div className="run-surface-past-body">
        {loading && <div className="run-surface-past-hint">Loading…</div>}
        {!loading && runs !== null && runs.length === 0 && (
          <div className="run-surface-past-hint">
            No earlier runs for this app yet.
          </div>
        )}
        {!loading && runs !== null && runs.length > 0 && (
          // Fix 3 (2026-04-19): show up to 5 recent runs as cards with
          // status-dot · input-summary → output-summary · relative time.
          // Clicking navigates to /p/:slug?run=<id> which hydrates via
          // the shared-run path.
          <ul className="run-surface-past-list" data-testid="run-surface-past-list">
            {runs.slice(0, 5).map((r) => {
              const inputPeek = summarizeInputs(r.inputs);
              const outputPeek = summarizeOutputs(r.outputs, r.status, r.error);
              const oneLine = `Input: ${inputPeek || '—'} · Output: ${outputPeek || '—'}`;
              return (
              <li key={r.id}>
                <Link
                  to={buildPublicRunPath(r.id)}
                  data-testid={`run-surface-past-row-${r.id}`}
                  className="run-surface-past-row"
                  title={oneLine}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--line)',
                    textDecoration: 'none',
                    color: 'var(--ink)',
                    minHeight: 44,
                  }}
                >
                  <span
                    aria-hidden="true"
                    data-status={r.status}
                    style={{
                      display: 'inline-block',
                      width: 8,
                      height: 8,
                      borderRadius: 999,
                      flexShrink: 0,
                      background: statusDotColor(r.status),
                    }}
                  />
                  <span
                    className="run-surface-past-preview-line"
                    style={{
                      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
                      fontSize: 12,
                      color: 'var(--ink)',
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {oneLine}
                  </span>
                  <span
                    className="run-surface-past-when"
                    style={{
                      fontSize: 11,
                      color: 'var(--muted)',
                      flexShrink: 0,
                    }}
                  >
                    {formatWhen(r.started_at)}
                  </span>
                </Link>
              </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}

/**
 * Map run status to a CSS color for the row's status dot. Green for
 * success, warning for timeout, red for errors, muted for anything else
 * (pending/running — which shouldn't appear in the history list but we
 * fall back gracefully).
 */
export function statusDotColor(status: string): string {
  if (status === 'success') return 'var(--accent, #10b981)';
  if (status === 'error') return 'var(--warning, #dc2626)';
  if (status === 'timeout') return 'var(--warning-soft, #f59e0b)';
  return 'var(--muted, #6b7280)';
}

/**
 * Produce a short human-readable snippet from a run's outputs for the
 * earlier-runs rail. Handles: error rows (shows the error string),
 * plain strings, and objects (picks the first non-empty primitive
 * field). Truncates at 40 chars.
 */
export function summarizeOutputs(
  outputs: unknown,
  status: string,
  error: string | null,
): string {
  if (status === 'error' || status === 'timeout') {
    const msg = (error || '').trim();
    return msg.length > 0
      ? msg.length > 40
        ? `${msg.slice(0, 37)}…`
        : msg
      : status;
  }
  if (outputs == null) return '';
  if (typeof outputs === 'string') {
    return outputs.length > 40 ? `${outputs.slice(0, 37)}…` : outputs;
  }
  if (typeof outputs === 'object') {
    const o = outputs as Record<string, unknown>;
    // Prefer common primary-field names first.
    const preferred = ['summary', 'uuid', 'result', 'output', 'text', 'message'];
    for (const key of preferred) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) {
        return v.length > 40 ? `${v.slice(0, 37)}…` : v;
      }
      if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
        const first = v[0] as string;
        return first.length > 40 ? `${first.slice(0, 37)}…` : first;
      }
    }
    // Fall back to the first non-empty primitive value.
    for (const v of Object.values(o)) {
      if (typeof v === 'string' && v.trim()) {
        return v.length > 40 ? `${v.slice(0, 37)}…` : v;
      }
      if (typeof v === 'number' || typeof v === 'boolean') {
        return String(v);
      }
    }
    const keys = Object.keys(o);
    if (keys.length > 0) return `{${keys.slice(0, 3).join(', ')}…}`;
  }
  return '';
}

function formatWhen(iso: string): string {
  try {
    const d = new Date(iso);
    const t = d.getTime();
    if (Number.isNaN(t)) return '';
    // Clamp negative diffs (future timestamps / clock skew) so fresh runs
    // never render `-Ns ago`. See lib/time.ts.
    const diff = Math.max(0, Date.now() - t);
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return d.toLocaleDateString();
  } catch {
    return '';
  }
}

function summarizeInputs(inputs: Record<string, unknown> | null | undefined): string {
  if (!inputs) return '';
  const entries = Object.entries(inputs).filter(([, v]) => v != null && v !== '');
  if (entries.length === 0) return '(no input)';
  const [, firstValue] = entries[0];
  const s = typeof firstValue === 'string' ? firstValue : JSON.stringify(firstValue);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

// ── Pure helpers exposed for tests ─────────────────────────────────────────
//
// These are intentionally small and side-effect free so stress tests can
// exercise the run-button labelling, layout hint, and async→run adaptation
// without mounting the full React tree. The component itself uses the same
// implementations inline above.

export function deriveRunLabel(args: {
  hasRun: boolean;
  refinable: boolean | undefined;
  /** When set (e.g. uuid/hash heuristics), keep the button on "Run". */
  refineSuppressed?: boolean;
}): 'Run' | 'Refine' {
  // Refine is opt-in: only flips on when the creator explicitly sets
  // `render.refinable: true` in the manifest. Default (undefined or false)
  // keeps the primary button on "Run" forever — desirable for one-shot
  // apps like uuid/hash where there's nothing to refine.
  const refinable = args.refinable === true && !args.refineSuppressed;
  return args.hasRun && refinable ? 'Refine' : 'Run';
}

export function deriveStacked(renderHint: string | undefined): boolean {
  return renderHint === 'stacked';
}

/**
 * Banner visibility rule for /p/:slug?run=<id> deep-links. The banner
 * reads "Viewing a shared run." + offers a "Run this yourself" reset,
 * visible only while the surface is still showing the hydrated initial
 * run. The first re-run (or explicit reset) clears ?run= in the parent,
 * which drops initialRun back to null and takes the banner with it.
 */
export function deriveSharedRunBanner(args: {
  initialRunId: string | null | undefined;
  currentRunId: string | null | undefined;
  phase: 'ready' | 'streaming' | 'job' | 'done' | 'error';
}): boolean {
  if (!args.initialRunId) return false;
  if (args.currentRunId !== args.initialRunId) return false;
  return args.phase === 'done';
}

export const __test__ = {
  deriveRunLabel,
  deriveStacked,
  deriveSharedRunBanner,
  jobToRunRecord,
  coerceInputs,
  buildInitialInputs,
  getDefaultActionSpec,
  summarizeInputs,
  summarizeOutputs,
  statusDotColor,
  formatWhen,
  formatRecapValue,
};
