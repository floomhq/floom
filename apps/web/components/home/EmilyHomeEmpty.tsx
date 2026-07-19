"use client";

// Home "stuff" rendered ABOVE the REAL Emily composer in EmilyChatCore's empty
// state when Emily is fullscreen on the home route ("/" or "/overview").
//
// FIX (Federico 2026-06-19): the home must be the EXISTING Emily shown FULLSCREEN
// with "some stuff" added to ITS empty state — NOT a parallel composer. This
// component is that "stuff" only: greeting + lean pulse + pills + the
// fix-as-prompt note. It has NO textarea/composer of its own. It seeds the real
// EmilyChatCore composer through `onSeed` and triggers the MCP modal via `onPickMcp`.
//
// Two layouts, gated by the workers fetch (resolveWorkersGate, NEVER on error/
// loading):
//   - First-worker (zero real workers): "Get your first worker running" hero +
//     the two real activation paths (PRIMARY "Browse templates" → the template
//     gallery; SECONDARY "Set up in your coding agent" → the Floom MCP install)
//     + helper pills that seed the composer (the assistant guides, it does not
//     build the worker in-dashboard).
//   - Active: greeting + "{done} done this week · {N} need attention" pulse
//     (the pulse degrades to just the greeting if the overview failed to load),
//     then active/fix pills.

import { useCallback, useEffect, useMemo, useState } from "react";

import { useOverview, useWorkers } from "@/lib/query/hooks";
import type {
  SystemOverview,
  SystemOverviewAttentionItem,
  OverviewSparklineBucket,
} from "@/lib/types";
import { api } from "@/lib/api";
import { getPublicSiteOrigin } from "@/lib/api-base";
import { useAssistantName } from "@/lib/workspace/assistant-name";
import { InlineToolToken } from "@/components/InlineToolToken";
import { tokenisePrompt } from "@/lib/prompt-detect";
import { isMachineLabel } from "@/lib/workspace/display-name";
import { Sparkline } from "@/components/Sparkline";
import { resolveWorkersGate } from "./emily-home-empty";
import { GoalOnboarding } from "./GoalOnboarding";

// ── small helpers ─────────────────────────────────────────────────────────────

function useGreeting() {
  const [greeting, setGreeting] = useState("Hello");
  const [firstName, setFirstName] = useState<string | null>(null);

  useEffect(() => {
    // Time-of-day greeting from the USER'S LOCAL time (Federico 2026-06-18:
    // "Good morning" was showing at night). `new Date().getHours()` runs only
    // in this client effect, so it reads the browser's local hour — never the
    // server/UTC hour. The initial SSR state is the neutral "Hello" until this
    // effect resolves, so there is no UTC flash either.
    const hour = new Date().getHours();
    if (hour < 12) setGreeting("Good morning");
    else if (hour < 18) setGreeting("Good afternoon");
    else setGreeting("Good evening");
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const me = await api.me();
        if (cancelled) return;
        // Never greet with a machine id: a "local-user" / UUID display_name
        // would render "Good morning, 9b1a5065…". Skip machine labels and
        // fall back to the email's human part, else no name.
        const display = isMachineLabel(me.display_name) ? "" : (me.display_name ?? "");
        const email = isMachineLabel(me.email) ? "" : (me.email ?? "");
        const source = display || email;
        const raw = display
          ? source.trim().split(/\s+/)[0]
          : source.split("@")[0]?.split(/[._-]/)[0] ?? "";
        const name = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : null;
        if (name && !isMachineLabel(name)) setFirstName(name);
      } catch {
        // no name available, greeting renders without one
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return { greeting, firstName };
}

function useTodayLabel() {
  const [label, setLabel] = useState("");
  useEffect(() => {
    setLabel(
      new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }),
    );
  }, []);
  return label;
}

function humanizeSlug(value: string | null | undefined, fallback: string) {
  if (!value) return fallback;
  const normalized = value.replace(/[_-]+/g, " ").trim();
  if (!normalized) return fallback;
  return normalized.replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
}

// Per-attention-item fix descriptor → seeds Emily with a per-worker fix prompt.
type FixItem = { id: string; name: string; why: string };

function attentionToFix(item: SystemOverviewAttentionItem, idx: number): FixItem {
  const name = item.worker_name || humanizeSlug(item.worker_id, "Worker");
  const why =
    item.message ||
    (item.recent_failure_count ? `${item.recent_failure_count} failures in 24h` : "run failed");
  return { id: item.worker_id || item.connection_id || `attn-${idx}`, name, why };
}

function formatCount(value: number | null | undefined) {
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(value ?? 0);
}

function formatTimeOfDay(iso: string | null | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

// Convert the 24h number[] into OverviewSparklineBucket[] so the shared
// Sparkline (area variant) receives a consistent type with hover labels.
function hourlyBuckets(values: number[] | undefined): OverviewSparklineBucket[] {
  return (values ?? []).map((total, i) => ({
    label: `${String(i).padStart(2, "0")}:00`,
    started_at: String(i),
    total,
    failed: 0,
  }));
}

// ── HomeStatsRow ──────────────────────────────────────────────────────────────
//
// Four real-data stat cards matching the dashboard overview:
//   1. Runs completed / last 7 days  — area sparkline from runs_7d_sparkline
//   2. Runs today                    — area sparkline from runs_24h_sparkline
//   3. Workers active                — text-only (no per-hour timeseries in API)
//   4. Coming up today               — text-only (no per-hour timeseries in API)
//
// Sparklines are rendered only when the API returns ≥2 data points; cards
// without real series degrade gracefully to text-only. This ensures the
// sparklines always reflect real workspace data, never placeholder values.

function HomeStatCard({
  label,
  value,
  detail,
  sparkline,
}: {
  label: string;
  value: string;
  detail: string;
  sparkline?: OverviewSparklineBucket[];
}) {
  const hasSparkline = sparkline && sparkline.length >= 2;
  return (
    <div className="flex min-h-[98px] min-w-0 flex-col rounded-[var(--radius-card)] bg-[var(--bg-2)] px-3.5 pt-3 pb-0 text-left">
      <div className="text-[10.5px] font-medium leading-tight text-[var(--ink-mute)]">{label}</div>
      <div className="mt-2 text-[22px] font-semibold leading-none tracking-normal text-ink">{value}</div>
      <div className="mt-1.5 text-[11.5px] leading-tight text-[var(--text-muted)]">{detail}</div>
      {hasSparkline ? (
        // Stretch the sparkline edge-to-edge to the card's padding boundary.
        // The negative -mx-3.5 pulls it flush; height is fixed at 28px so the
        // card stays compact. preserveAspectRatio="none" (via variant="area")
        // scales the polyline to fill the full width regardless of bucket count.
        <div className="mt-auto -mx-3.5 h-7 overflow-hidden">
          <Sparkline
            data={sparkline}
            height={28}
            variant="area"
            className="h-full w-full"
          />
        </div>
      ) : (
        // Reserve the same 28px bottom space when there is no sparkline so
        // all four cards stay the same height.
        <div className="mt-auto h-7" aria-hidden="true" />
      )}
    </div>
  );
}

function HomeStatsRow({
  stats,
}: {
  stats: SystemOverview["stats"];
}) {
  const completedThisWeek = stats.work_shipped_7d ?? 0;
  const runsToday = stats.runs_today ?? stats.runs_24h ?? 0;
  const completedToday = stats.completed_today ?? 0;
  const failedToday = stats.failed_today ?? 0;
  const activeWorkers = stats.active_workers_count ?? 0;
  const pausedWorkers = stats.paused_workers_count ?? 0;
  const scheduledToday = stats.scheduled_24h_count ?? 0;
  const nextAt = stats.next_scheduled_at;

  // Sparkline series — undefined when the API doesn't return enough points.
  const runs7dSeries: OverviewSparklineBucket[] | undefined =
    stats.runs_7d_sparkline && stats.runs_7d_sparkline.length >= 2
      ? stats.runs_7d_sparkline
      : undefined;

  const runs24hSeries: OverviewSparklineBucket[] | undefined =
    stats.runs_24h_sparkline && stats.runs_24h_sparkline.length >= 2
      ? hourlyBuckets(stats.runs_24h_sparkline)
      : undefined;

  const todayDetail =
    completedToday > 0 || failedToday > 0
      ? `${formatCount(completedToday)} ok · ${formatCount(failedToday)} failed`
      : `${formatCount(runsToday)} in last 24h`;

  const nextScheduledDetail = nextAt
    ? `Next at ${formatTimeOfDay(nextAt)}`
    : "No runs scheduled";

  return (
    <div className="my-5 grid w-full max-w-[760px] grid-cols-2 gap-2.5 md:grid-cols-4">
      <HomeStatCard
        label="Runs completed"
        value={formatCount(completedThisWeek)}
        detail="last 7 days"
        sparkline={runs7dSeries}
      />
      <HomeStatCard
        label="Runs today"
        value={formatCount(runsToday)}
        detail={todayDetail}
        sparkline={runs24hSeries}
      />
      <HomeStatCard
        label="Workers active"
        value={formatCount(activeWorkers)}
        detail={`${formatCount(pausedWorkers)} paused`}
      />
      <HomeStatCard
        label="Coming up today"
        value={formatCount(scheduledToday)}
        detail={nextScheduledDetail}
      />
    </div>
  );
}

// ── pills ─────────────────────────────────────────────────────────────────────

// Inline tool tokens (Federico 2026-06-21): render an example prompt with its
// tool names highlighted INLINE, each with its real brand icon — the same
// register as the marketing landing prompt box, NOT a separate "Uses [pill]
// [pill]" row. Uses the SHARED InlineToolToken so this and the PromptChips
// composer row can't diverge. The button's accessible name stays the full prompt
// string so seeding + a11y are unchanged.
function PromptTokens({ text }: { text: string }) {
  const segments = tokenisePrompt(text);
  return (
    <>
      {segments.map((seg, i) => {
        if (seg.kind === "plain") {
          return <span key={i}>{seg.text}</span>;
        }
        return (
          <InlineToolToken key={i} brand={seg.brand} className="mx-px">
            {seg.text}
          </InlineToolToken>
        );
      })}
    </>
  );
}

function Pill({
  children,
  onClick,
  accent,
  fix,
}: {
  children: React.ReactNode;
  onClick: () => void;
  accent?: boolean;
  fix?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "inline-flex items-center gap-1.5 rounded-[var(--radius-button)] px-3 py-1.5 text-[12.5px] transition-colors " +
        (accent
          ? "bg-[var(--accent-soft)] text-[var(--accent)] hover:opacity-90"
          : "bg-[var(--bg-2)] text-[var(--ink-soft)] hover:bg-[var(--bg-3)] hover:text-ink")
      }
    >
      {fix && (
        <svg className="text-[var(--warning)]" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      )}
      {children}
    </button>
  );
}

// The template gallery: the primary web activation path. Pick a ready-made
// worker and "Add to workspace" lands it running in one click. Built from the
// public site origin so a self-hosted instance (NEXT_PUBLIC_SITE_ORIGIN) points
// at its own gallery, and managed Cloud points at floom.dev/templates.
const TEMPLATES_URL = `${getPublicSiteOrigin()}/templates`;

// First-run pills seed the REAL composer with questions the assistant can
// actually answer — it HELPS you choose a template or set up your coding agent,
// it does NOT build the worker in the dashboard. (Worker creation runs in your
// coding agent via the Floom MCP server, or you start from a template.)
const CREATE_PILLS = [
  "Which template fits my team?",
  "How do I run a template?",
  "What can Floom connect to?",
] as const;

const ACTIVE_PILLS = [
  "What ran overnight?",
  "How do I add another worker?",
  "Show me this week's runs",
] as const;

// ── the home empty-state block ─────────────────────────────────────────────────

export function EmilyHomeEmpty({
  initialData = null,
  onSeed,
  onPickMcp,
  createMode = false,
}: {
  /** Server-rendered overview for the pulse, hydrates without a round-trip. */
  initialData?: SystemOverview | null;
  /** Seed the REAL Emily composer with text (does NOT send). */
  onSeed: (text: string) => void;
  /** Open the MCP-server browse modal. */
  onPickMcp: () => void;
  /** New-worker entry: show worker-building prompts, not ops/status prompts. */
  createMode?: boolean;
}) {
  const assistantName = useAssistantName();
  const { greeting, firstName } = useGreeting();
  const todayLabel = useTodayLabel();

  // Pulse data (Active state). Reuse the real overview hook. Degrades to just
  // the greeting if the overview failed to load — NEVER show a broken pulse.
  const overviewQuery = useOverview(initialData);
  const overview = overviewQuery.data ?? null;
  const pulseOk = Boolean(overview) && !overviewQuery.isError;

  // First-worker gate. Reuse the real workers hook. The gate NEVER trips on a
  // fetch error or while loading (resolveWorkersGate enforces this).
  const workersQuery = useWorkers();
  const gate = resolveWorkersGate({
    workers: workersQuery.data,
    isLoading: workersQuery.isLoading && !workersQuery.data,
    isError: workersQuery.isError,
  });
  const isFirstWorker = gate.isFirstWorker;
  const showCreatePrompts = createMode || isFirstWorker;

  // Fix-as-prompt: needs-attention items + per-worker fix pills.
  const attention = useMemo(() => overview?.needs_attention ?? [], [overview]);
  const fixItems = useMemo(() => attention.map((a, i) => attentionToFix(a, i)), [attention]);
  const needsAttentionCount = attention.length;
  const workDoneThisWeek =
    overview?.stats.work_shipped_7d ??
    overview?.outcomes?.reduce((total, item) => total + item.count, 0) ??
    0;
  const overviewStats = pulseOk ? overview?.stats : null;
  const [fixMode, setFixMode] = useState(false);

  // Seed the REAL composer from a fix (whole-batch or per-worker) without
  // sending — copy is explicit: Emily will PROPOSE a fix for you to approve.
  const seedFixAll = useCallback(() => {
    if (fixItems.length === 0) return;
    setFixMode(true);
    const names = fixItems.map((f) => f.name).join(" and ");
    onSeed(`${names} failed, propose a fix and re-run.`);
  }, [fixItems, onSeed]);

  const seedFixOne = useCallback(
    (f: FixItem) => {
      setFixMode(true);
      onSeed(`${f.name} failed, ${f.why.toLowerCase()}. Propose a fix and re-run.`);
    },
    [onSeed],
  );

  if (isFirstWorker && !createMode) {
    return <GoalOnboarding />;
  }

  return (
    <div className="flex w-full max-w-[760px] flex-col items-center px-6">
      {/* greeting / hero */}
      {showCreatePrompts ? (
        <div className="flex flex-col items-center pb-[22px]">
          <div className="text-center text-[21px] font-semibold tracking-[-0.02em] text-ink">
            {isFirstWorker ? "Get your first worker running" : "Add another worker"}
          </div>
          <div className="mt-[7px] max-w-[400px] text-center text-[13.5px] leading-[1.5] text-[var(--text-muted)]">
            Start from a ready-made template, or set up Floom in your coding agent
            to build your own. {assistantName} can help you choose.
          </div>
        </div>
      ) : (
        <>
          <div className="text-center">
            <div className="text-[21px] font-semibold tracking-[-0.02em] text-ink">
              {greeting}
              {firstName ? `, ${firstName}` : ""}
            </div>
            <div className="mt-[3px] text-[12.5px] text-[var(--text-muted)]">{todayLabel}</div>
            {/* Lean pulse — only when the overview actually loaded (degrade to
                just the greeting on a failed/loading overview, never a broken pulse). */}
            {pulseOk && (
              <div className="mt-3.5 inline-flex flex-wrap items-center justify-center gap-2.5 text-[13px] text-[var(--text-muted)]">
                <span>
                  <b className="font-semibold text-ink">{workDoneThisWeek}</b>&nbsp;done this week
                </span>
                {needsAttentionCount > 0 && (
                  <>
                    <span className="opacity-35">·</span>
                    <button
                      type="button"
                      onClick={seedFixAll}
                      className="-mx-1.5 -my-0.5 inline-flex items-center gap-1.5 rounded-[var(--radius-button)] px-1.5 py-0.5 font-medium text-[var(--ink-mute)] outline-none transition-colors hover:bg-[color-mix(in_srgb,var(--warning)_9%,transparent)] hover:text-[var(--warning)] focus-visible:bg-[color-mix(in_srgb,var(--warning)_9%,transparent)] focus-visible:text-[var(--warning)]"
                    >
                      <span className="size-1.5 shrink-0 rounded-[2px] bg-[var(--warning)]" aria-hidden="true" />
                      {needsAttentionCount} need attention
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          {overviewStats && (
            <HomeStatsRow
              stats={overviewStats}
            />
          )}
        </>
      )}

      {/* Two real activation paths (BELOW the hero, ABOVE the real composer the
          host renders next). PRIMARY = start from a template (the gallery's
          "Add to workspace" lands a running worker in one click). SECONDARY =
          set up Floom in a coding agent (Claude Code, Codex, Cursor, …) via the
          Floom MCP server. The assistant is a helper for both, not a builder. */}
      {showCreatePrompts ? (
        <>
          <div className="flex flex-wrap items-center justify-center gap-2.5">
            {/* PRIMARY: template gallery */}
            <a
              href={TEMPLATES_URL}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--accent)] px-4 py-2 text-[13px] font-medium text-white transition-opacity hover:opacity-90"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect width="7" height="7" x="3" y="3" rx="1" />
                <rect width="7" height="7" x="14" y="3" rx="1" />
                <rect width="7" height="7" x="14" y="14" rx="1" />
                <rect width="7" height="7" x="3" y="14" rx="1" />
              </svg>
              Browse templates
            </a>
            {/* SECONDARY: coding-agent / MCP native path */}
            <button
              type="button"
              onClick={onPickMcp}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--bg-2)] px-4 py-2 text-[13px] font-medium text-[var(--ink-soft)] transition-colors hover:bg-[var(--bg-3)] hover:text-ink"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="4 17 10 11 4 5" />
                <line x1="12" x2="20" y1="19" y2="19" />
              </svg>
              Set up in your coding agent
            </button>
          </div>
          {/* Helper prompts — seed the REAL composer with questions the assistant
              can answer (choose a template, connect a tool). It guides; it does
              not build the worker here. */}
          <div className="mt-[18px] flex flex-wrap justify-center gap-2">
            {CREATE_PILLS.map((p) => (
              <Pill key={p} onClick={() => onSeed(p)}>
                <PromptTokens text={p} />
              </Pill>
            ))}
          </div>
        </>
      ) : (
        <div className="flex flex-wrap justify-center gap-2">
          {fixMode
            ? fixItems.map((f) => (
                <Pill key={f.id} fix onClick={() => seedFixOne(f)}>
                  Fix {f.name}, {f.why}
                </Pill>
              ))
            : ACTIVE_PILLS.map((p) => (
                <Pill key={p} onClick={() => onSeed(p)}>
                  {p}
                </Pill>
              ))}
        </div>
      )}
    </div>
  );
}
