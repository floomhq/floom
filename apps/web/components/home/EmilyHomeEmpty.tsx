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
import { Avatar } from "@/components/ui/Avatar";
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
        const source = me.display_name || me.email || "";
        const raw = me.display_name
          ? source.trim().split(/\s+/)[0]
          : source.split("@")[0]?.split(/[._-]/)[0] ?? "";
        const name = raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : null;
        if (name) setFirstName(name);
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

// ── pills ─────────────────────────────────────────────────────────────────────

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
  "Summarise my Granola meetings → HubSpot",
  "Daily GitHub PR digest",
  "Alert me on big Stripe charges",
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
}: {
  /** Server-rendered overview for the pulse, hydrates without a round-trip. */
  initialData?: SystemOverview | null;
  /** Seed the REAL Emily composer with text (does NOT send). */
  onSeed: (text: string) => void;
  /** Open the MCP-server browse modal. */
  onPickMcp: () => void;
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

  // Fix-as-prompt: needs-attention items + per-worker fix pills.
  const attention = useMemo(() => overview?.needs_attention ?? [], [overview]);
  const fixItems = useMemo(() => attention.map((a, i) => attentionToFix(a, i)), [attention]);
  const needsAttentionCount = attention.length;
  const workDoneThisWeek =
    overview?.stats.work_shipped_7d ??
    overview?.outcomes?.reduce((total, item) => total + item.count, 0) ??
    0;
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
    <div className="flex w-full max-w-[600px] flex-col items-center px-6">
      {/* greeting / hero */}
      {isFirstWorker ? (
        <div className="flex flex-col items-center pb-[22px]">
          <div className="mb-4">
            <Avatar role="emily" size={46} />
          </div>
          <div className="text-center text-[21px] font-semibold tracking-[-0.02em] text-ink">
            Let&apos;s hire your first worker
          </div>
          <div className="mt-[7px] max-w-[360px] text-center text-[13.5px] leading-[1.5] text-[var(--text-muted)]">
            Describe what you want automated. {assistantName} builds it, connects the
            tools, and runs it.
          </div>
        </div>
      ) : (
        <div className="pb-[22px] text-center">
          <div className="text-[15px] font-medium tracking-[-0.01em] text-ink">
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
      )}

      {/* pills (BELOW the hero, ABOVE the real composer the host renders next) */}
      {isFirstWorker ? (
        <>
          <div className="flex flex-wrap justify-center gap-2">
            {CREATE_PILLS.map((p) => (
              <Pill key={p} onClick={() => onSeed(p)}>
                {p}
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
