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
//   - First-worker (zero real workers): "Let's hire your first worker" hero +
//     create pills + "Find an MCP server".
//   - Active: greeting + "{done} done this week · {N} need attention" pulse
//     (the pulse degrades to just the greeting if the overview failed to load),
//     then active/fix pills.

import { useCallback, useEffect, useMemo, useState } from "react";

import { useOverview, useWorkers } from "@/lib/query/hooks";
import type {
  SystemOverview,
  SystemOverviewAttentionItem,
} from "@/lib/types";
import { api } from "@/lib/api";
import { useAssistantName } from "@/lib/workspace/assistant-name";
import { InlineToolToken } from "@/components/InlineToolToken";
import { tokenisePrompt } from "@/lib/prompt-detect";
import { isMachineLabel } from "@/lib/workspace/display-name";
import { resolveWorkersGate } from "./emily-home-empty";

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

function pluralize(count: number, singular: string, plural = `${singular}s`) {
  return count === 1 ? singular : plural;
}

type HomeStat = {
  label: string;
  value: string;
  detail: string;
  attention?: boolean;
};

function HomeStatsRow({
  stats,
  needsAttentionCount,
}: {
  stats: SystemOverview["stats"];
  needsAttentionCount: number;
}) {
  const totalWorkers = (stats.active_workers_count ?? 0) + (stats.paused_workers_count ?? 0);
  const runningOrQueued = (stats.running_now ?? 0) + (stats.queued_now ?? 0);
  const healthyConnections = stats.connections_healthy ?? 0;
  const totalConnections = stats.connections_total ?? 0;
  const completedThisWeek = stats.work_shipped_7d ?? 0;
  const items: HomeStat[] = [
    {
      label: "Total workers",
      value: formatCount(totalWorkers),
      detail: `${formatCount(stats.paused_workers_count)} paused`,
    },
    {
      label: "Active workers",
      value: formatCount(stats.active_workers_count),
      detail:
        stats.queued_now && stats.queued_now > 0
          ? `${formatCount(stats.running_now)} running, ${formatCount(stats.queued_now)} queued`
          : `${formatCount(runningOrQueued)} ${pluralize(runningOrQueued, "run")} live`,
    },
    {
      label: "Runs this week",
      value: formatCount(completedThisWeek),
      detail: "completed",
    },
    {
      label: "Connections",
      value: totalConnections > 0 ? `${formatCount(healthyConnections)}/${formatCount(totalConnections)}` : "0",
      detail: totalConnections > 0 ? "healthy" : "none connected",
    },
    {
      label: "Needs attention",
      value: formatCount(needsAttentionCount),
      detail: needsAttentionCount > 0 ? "ready to triage" : "clear",
      attention: needsAttentionCount > 0,
    },
  ];

  return (
    <div className="my-5 grid w-full max-w-[760px] grid-cols-2 gap-2.5 md:grid-cols-5">
      {items.map((item) => (
        <div
          key={item.label}
          className={
            "min-h-[98px] min-w-0 rounded-[var(--radius-card)] px-3.5 py-3 text-left " +
            (item.attention
              ? "bg-[color-mix(in_srgb,var(--warning)_10%,var(--bg-card))]"
              : "bg-[var(--bg-2)]")
          }
        >
          <div className="text-[10.5px] font-medium leading-tight text-[var(--ink-mute)]">{item.label}</div>
          <div className="mt-2 text-[22px] font-semibold leading-none tracking-normal text-ink">{item.value}</div>
          <div className="mt-2 text-[11.5px] leading-tight text-[var(--text-muted)]">{item.detail}</div>
        </div>
      ))}
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

const CREATE_PILLS = [
  "Create a Linear triage worker",
  "Daily GitHub PR digest",
  "Daily Slack standup reminder",
] as const;

const ACTIVE_PILLS = [
  "What ran overnight?",
  "Create a Linear triage worker",
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

  return (
    <div className="flex w-full max-w-[760px] flex-col items-center px-6">
      {/* greeting / hero */}
      {showCreatePrompts ? (
        <div className="flex flex-col items-center pb-[22px]">
          <div className="text-center text-[21px] font-semibold tracking-[-0.02em] text-ink">
            {isFirstWorker ? "Let's hire your first worker" : "What should this worker do?"}
          </div>
          <div className="mt-[7px] max-w-[360px] text-center text-[13.5px] leading-[1.5] text-[var(--text-muted)]">
            Describe what you want automated. {assistantName} builds it, connects the
            tools, and runs it.
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
              needsAttentionCount={needsAttentionCount}
            />
          )}
        </>
      )}

      {/* pills (BELOW the hero, ABOVE the real composer the host renders next) */}
      {showCreatePrompts ? (
        <>
          <div className="flex flex-wrap justify-center gap-2">
            {CREATE_PILLS.map((p) => (
              <Pill key={p} onClick={() => onSeed(p)}>
                <PromptTokens text={p} />
              </Pill>
            ))}
            <Pill accent onClick={onPickMcp}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
              Find an MCP server
            </Pill>
          </div>
          <button
            type="button"
            onClick={onPickMcp}
            className="mt-[18px] inline-flex items-center gap-1.5 rounded-[var(--radius-button)] px-1 py-0.5 text-[12px] font-medium text-[var(--ink-mute)] transition-colors hover:text-ink"
          >
            See what {assistantName} can connect
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5 12h14" />
              <path d="m12 5 7 7-7 7" />
            </svg>
          </button>
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
