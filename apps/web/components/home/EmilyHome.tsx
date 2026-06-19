"use client";

// Emily-fullscreen HOME, replaces the old Overview page.
//
// Spec: the approved mockup /tmp/emily-home-mockup/v6.html (Federico's flagship
// redesign). The home IS Emily, full-screen inside the app shell (the left
// sidebar stays). Three states:
//
//   A · First-worker  (workspace has ZERO real workers): a create-only hero , 
//       Emily radar mark, "Let's hire your first worker", a unified composer
//       ("Ask Emily, or describe a worker to build…"), create pills + a
//       "Find an MCP server" pill + a quiet "See what Emily can connect" link.
//       NO pulse. Gated on a SUCCESSFUL workers fetch with 0 real workers, see
//       resolveWorkersGate(); NEVER shown on a fetch error / while loading.
//
//   B · Active  (has workers): a lean one-line pulse, "{done} done this week ·
//       {N} need attention", then the unified composer, then a few pills. The
//       "need attention" affordance is CALM at rest (muted ink + a small warning
//       dot), warning-orange only on hover/focus.
//
//   D · Drafting  (post-submit): the home BECOMES the Emily conversation. We
//       mount the SAME real EmilyChatCore (createMode) inline so the worker is
//       drafted by the real backend + rendered via the real worker-draft tool
//       card, we do not rebuild Emily or fake a draft block.
//
// Data: reuses the real useOverview (pulse) + useWorkers (gate) hooks. No new
// data layer.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useOverview, useWorkers } from "@/lib/query/hooks";
import type {
  SystemOverview,
  SystemOverviewAttentionItem,
} from "@/lib/types";
import { api } from "@/lib/api";
import { useAssistantName } from "@/lib/workspace/assistant-name";
import { EmilyChatCore } from "@/components/emily/EmilyChat";
import { useMcpModal } from "@/components/mcp/mcp-modal-context";
import { EmilyRadarMark } from "./EmilyRadarMark";
import { resolveWorkersGate } from "./emily-home-empty";

// ── small helpers ─────────────────────────────────────────────────────────────

function useGreeting() {
  const [greeting, setGreeting] = useState("Hello");
  const [firstName, setFirstName] = useState<string | null>(null);

  useEffect(() => {
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

// ── composer (the jewel) ──────────────────────────────────────────────────────

const ArrowRightIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M5 12h14" />
    <path d="m12 5 7 7-7 7" />
  </svg>
);

function HomeComposer({
  value,
  onChange,
  onSubmit,
  seeded,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  seeded: boolean;
  placeholder: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // auto-grow up to 140px
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`;
  }, [value]);

  const live = value.trim().length > 0;
  return (
    <div className="w-full max-w-[600px]">
      <div
        className={
          "flex items-end gap-2.5 rounded-[var(--radius-button)] px-4 py-3.5 transition-[background,box-shadow] " +
          (seeded
            ? "bg-[var(--bg-card)] shadow-[0_0_0_1.5px_var(--accent),0_8px_22px_hsl(0_0%_0%/.06)]"
            : "bg-[var(--bg-2)] focus-within:bg-[var(--bg-3)]")
        }
      >
        <span className="mb-px shrink-0">
          <EmilyRadarMark size={26} variant="accent" />
        </span>
        <textarea
          ref={ref}
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (live) onSubmit();
            }
          }}
          placeholder={placeholder}
          aria-label="Ask Emily or describe a worker to build"
          className="min-h-[26px] w-full flex-1 resize-none bg-transparent pt-0.5 text-[15px] leading-[1.5] text-ink outline-none placeholder:text-[var(--text-muted)]"
        />
        <button
          type="button"
          onClick={() => live && onSubmit()}
          disabled={!live}
          aria-label="Send"
          className={
            "flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] transition-[opacity,background,color] " +
            (live
              ? "bg-[var(--accent)] text-white hover:opacity-90"
              : "bg-[var(--bg-3)] text-[var(--ink-faint)]")
          }
        >
          <ArrowRightIcon />
        </button>
      </div>
    </div>
  );
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

// ── the home ──────────────────────────────────────────────────────────────────

export function EmilyHome({
  initialData = null,
}: {
  initialData?: SystemOverview | null;
}) {
  const assistantName = useAssistantName();
  const mcpModal = useMcpModal();
  const { greeting, firstName } = useGreeting();
  const todayLabel = useTodayLabel();

  // Pulse data (Active state), reuse the real overview hook.
  const overviewQuery = useOverview(initialData);
  const overview = overviewQuery.data ?? null;

  // First-worker gate, reuse the real workers hook. The gate NEVER trips on a
  // fetch error or while loading (resolveWorkersGate enforces this).
  const workersQuery = useWorkers();
  const gate = resolveWorkersGate({
    workers: workersQuery.data,
    isLoading: workersQuery.isLoading && !workersQuery.data,
    isError: workersQuery.isError,
  });
  const isFirstWorker = gate.isFirstWorker;

  // Drafting transition, once the user submits a create prompt the home becomes
  // the real Emily conversation (createMode core, auto-submitted).
  const [draftPrompt, setDraftPrompt] = useState<string | null>(null);

  // Composer state (A/B).
  const [input, setInput] = useState("");
  const [seeded, setSeeded] = useState(false);

  // Fix-as-prompt: needs-attention items + per-worker fix pills.
  const attention = overview?.needs_attention ?? [];
  const fixItems = useMemo(() => attention.map((a, i) => attentionToFix(a, i)), [attention]);
  const needsAttentionCount = attention.length;
  const workDoneThisWeek =
    overview?.stats.work_shipped_7d ??
    overview?.outcomes?.reduce((total, item) => total + item.count, 0) ??
    0;
  const [fixMode, setFixMode] = useState(false);

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setDraftPrompt(text);
  }, [input]);

  // Seed the composer from a fix (whole-batch or per-worker) without sending , 
  // copy is explicit: Emily will PROPOSE a fix you approve.
  const seedFixAll = useCallback(() => {
    if (fixItems.length === 0) return;
    setFixMode(true);
    const names = fixItems.map((f) => f.name).join(" and ");
    setInput(`${names} failed, propose a fix and re-run.`);
    setSeeded(true);
  }, [fixItems]);

  const seedFixOne = useCallback((f: FixItem) => {
    setFixMode(true);
    setInput(`${f.name} failed, ${f.why.toLowerCase()}. Propose a fix and re-run.`);
    setSeeded(true);
  }, []);

  const onChangeInput = useCallback((v: string) => {
    setInput(v);
    if (!v.trim()) {
      setSeeded(false);
      setFixMode(false);
    }
  }, []);

  // ── DRAFTING ────────────────────────────────────────────────────────────────
  if (draftPrompt) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <EmilyChatCore fullPage createMode autoSubmitPrime primeInput={draftPrompt} />
      </div>
    );
  }

  // ── HOME (A & B), composer-anchored ───────────────────────────────────────────
  return (
    <div className="relative h-full min-h-0 overflow-y-auto">
      <div
        className="absolute left-1/2 flex w-full max-w-[600px] -translate-x-1/2 flex-col items-center px-6"
        style={{ top: "calc(40vh - 56px)" }}
      >
        {/* ABOVE the composer, greeting/hero stack upward, never moving the anchor */}
        <div className="absolute inset-x-0 bottom-full flex flex-col items-center px-6 pb-[22px]">
          {isFirstWorker ? (
            <div className="flex flex-col items-center">
              <div className="mb-4">
                <EmilyRadarMark size={46} variant="ink" />
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
            <div className="text-center">
              <div className="text-[15px] font-medium tracking-[-0.01em] text-ink">
                {greeting}
                {firstName ? `, ${firstName}` : ""}
              </div>
              <div className="mt-[3px] text-[12.5px] text-[var(--text-muted)]">{todayLabel}</div>
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
            </div>
          )}
        </div>

        {/* THE COMPOSER (anchored, shared hero for A & B) */}
        <HomeComposer
          value={input}
          onChange={onChangeInput}
          onSubmit={submit}
          seeded={seeded}
          placeholder="Ask Emily, or describe a worker to build…"
        />

        {/* BELOW the composer, grows downward, never moves the anchor */}
        <div className="flex w-full flex-col items-center">
          {/* seeded annotation (fix-as-prompt) */}
          {seeded && (
            <div className="mt-2.5 flex items-start gap-1.5 pl-0.5 text-left text-[11.5px] leading-[1.45] text-[var(--accent)]">
              <svg className="mt-0.5 shrink-0" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M5 12h14" />
                <path d="m12 5 7 7-7 7" />
              </svg>
              <span>
                {fixMode
                  ? `${assistantName} will PROPOSE a fix you approve. Press send, or tap one to fix just that worker.`
                  : `${assistantName} will PROPOSE a fix you approve. Press send to start.`}
              </span>
            </div>
          )}

          {/* pills */}
          {isFirstWorker ? (
            <>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {CREATE_PILLS.map((p) => (
                  <Pill key={p} onClick={() => setInput(p)}>
                    {p}
                  </Pill>
                ))}
                <Pill accent onClick={() => mcpModal.open()}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <circle cx="11" cy="11" r="8" />
                    <path d="m21 21-4.3-4.3" />
                  </svg>
                  Find an MCP server
                </Pill>
              </div>
              <button
                type="button"
                onClick={() => mcpModal.open()}
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
            <div className="mt-4 flex flex-wrap justify-center gap-2">
              {fixMode
                ? fixItems.map((f) => (
                    <Pill key={f.id} fix onClick={() => seedFixOne(f)}>
                      Fix {f.name}, {f.why}
                    </Pill>
                  ))
                : ACTIVE_PILLS.map((p) => (
                    <Pill key={p} onClick={() => setInput(p)}>
                      {p}
                    </Pill>
                  ))}
            </div>
          )}

          <p className="mt-5 text-center text-[10.5px] text-[var(--text-muted)]">
            {assistantName} can make mistakes. Verify important results.
          </p>
        </div>
      </div>
    </div>
  );
}
