"use client";

/**
 * V3Composer — the jewel. One saturated object on the page.
 * Bigger presence than v2: taller, more inner air, the button is the only
 * blue at rest. Flat at rest, accent ring on focus. Tool names highlight
 * as you type. No channel row, no extra chrome.
 */

import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Plus } from "lucide-react";
import { appUrl } from "@/lib/app-url";
import {
  GCalLogo,
  GmailLogo,
  GitHubSVG,
  GranolaLogo,
  HubSpotLogo,
  NotionLogo,
  SheetsLogo,
  SlackLogo,
  WhatsAppLogo,
} from "@/components/landing-icons";

const KNOWN_TOOLS: Array<{ keys: string[] }> = [
  { keys: ["slack"] },
  { keys: ["whatsapp"] },
  { keys: ["gmail"] },
  { keys: ["google calendar", "gcal"] },
  { keys: ["hubspot crm", "hubspot"] },
  { keys: ["google sheets", "sheets"] },
  { keys: ["notion"] },
  { keys: ["granola"] },
  { keys: ["github"] },
  { keys: ["linear"] },
];

type Match = { start: number; end: number };

/* map from lowercase key → logo component */
const TOOL_LOGOS: Record<string, React.ReactNode> = {
  slack: <SlackLogo />,
  whatsapp: <WhatsAppLogo />,
  gmail: <GmailLogo />,
  "google calendar": <GCalLogo />,
  gcal: <GCalLogo />,
  "hubspot crm": <HubSpotLogo />,
  hubspot: <HubSpotLogo />,
  "google sheets": <SheetsLogo />,
  sheets: <SheetsLogo />,
  notion: <NotionLogo />,
  granola: <GranolaLogo />,
  github: <GitHubSVG />,
  linear: null,
};

function detectMatches(text: string): Match[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const word = /[a-z0-9]/;
  const raw: Match[] = [];
  for (const t of KNOWN_TOOLS) {
    for (const key of t.keys) {
      let i = 0;
      while (i < lower.length) {
        const at = lower.indexOf(key, i);
        if (at === -1) break;
        const before = at === 0 ? "" : lower[at - 1];
        const after = at + key.length >= lower.length ? "" : lower[at + key.length];
        if (!word.test(before) && !word.test(after)) raw.push({ start: at, end: at + key.length });
        i = at + key.length;
      }
    }
  }
  raw.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  const out: Match[] = [];
  for (const m of raw) {
    const last = out[out.length - 1];
    if (!last || m.start >= last.end) out.push(m);
  }
  return out;
}

function Mirror({ text, matches }: { text: string; matches: Match[] }) {
  const safe = text.endsWith("\n") ? text + " " : text;
  if (!matches.length) return <>{safe}</>;
  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) out.push(safe.slice(cursor, m.start));
    const key = safe.slice(m.start, m.end).toLowerCase();
    const logo = TOOL_LOGOS[key] ?? null;
    out.push(
      <span key={`hl-${m.start}`} className="v3-hl inline-flex items-center gap-[3px] align-baseline whitespace-nowrap">
        {logo && (
          <span className="inline-flex h-[13px] w-[13px] shrink-0 items-center justify-center [&_svg]:h-[13px] [&_svg]:w-[13px]">
            {logo}
          </span>
        )}
        {safe.slice(m.start, m.end)}
      </span>,
    );
    cursor = m.end;
  }
  if (cursor < safe.length) out.push(safe.slice(cursor));
  return <>{out}</>;
}

export function V3Composer({
  heading,
  placeholder = "Every Monday, summarise last week's pipeline in #sales…",
  compact = false,
  fillSignal,
}: {
  heading?: string;
  placeholder?: string;
  compact?: boolean;
  /** parent-driven fill: { text, n } where n changes per click */
  fillSignal?: { text: string; n: number } | null;
}) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const matches = useMemo(() => detectMatches(value), [value]);

  useEffect(() => {
    if (fillSignal && fillSignal.text) setValue(fillSignal.text);
  }, [fillSignal]);

  function submit() {
    const v = value.trim();
    if (!v) return;
    window.location.assign(appUrl("/workers/new", { prompt: v }));
  }

  return (
    <motion.form
      data-v3-composer="hero"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
      }}
      animate={{ scale: focused ? 1.01 : 1 }}
      transition={{ type: "spring", stiffness: 150, damping: 24 }}
      className={`mx-auto w-full rounded-[20px] bg-secondary text-left ${compact ? "max-w-[440px] p-3.5" : "max-w-[640px] p-5"}`}
      style={{
        boxShadow: focused ? "0 0 0 1.5px var(--v3-accent)" : "none",
        transition: "box-shadow 180ms cubic-bezier(0.22,1,0.36,1)",
      }}
    >
      {heading ? (
        <div className="mb-2 px-1 text-[13px] font-semibold tracking-[-0.01em] text-foreground">
          {heading}
        </div>
      ) : null}
      <div className="relative">
        <div
          aria-hidden
          className={`pointer-events-none absolute inset-0 whitespace-pre-wrap break-words px-1 text-left leading-relaxed text-foreground ${compact ? "pb-2 pt-0 text-[14px]" : "pb-6 pt-1 text-[15.5px]"}`}
        >
          <Mirror text={value} matches={matches} />
        </div>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={placeholder}
          rows={compact ? 1 : 2}
          className={`relative w-full resize-none bg-transparent px-1 text-left leading-relaxed placeholder:text-muted-foreground ${compact ? "pb-2 pt-0 text-[14px]" : "pb-6 pt-1 text-[15.5px]"}`}
          style={
            value
              ? { color: "transparent", caretColor: "var(--text-primary)", WebkitTextFillColor: "transparent" }
              : { caretColor: "var(--text-primary)" }
          }
          aria-label="Describe the job"
        />
      </div>
      <div className={`flex items-center justify-end ${compact ? "pt-0" : "pt-1"}`}>
        <motion.button
          type="submit"
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.98 }}
          className={`flex items-center gap-2 rounded-[12px] font-medium text-white ${compact ? "px-4 py-2 text-[13px]" : "px-5 py-2.5 text-[14px]"}`}
          style={{ background: "var(--v3-accent)" }}
        >
          Hire
          <ArrowUp className="h-4 w-4" />
        </motion.button>
      </div>
    </motion.form>
  );
}

export function V3StickyPrompt() {
  const [value, setValue] = useState("");
  const [visible, setVisible] = useState(false);
  const [nearFooter, setNearFooter] = useState(false);
  const matches = useMemo(() => detectMatches(value), [value]);

  useEffect(() => {
    function update() {
      const doc = document.documentElement;
      const scrolled = window.scrollY > 260;
      const distanceToBottom = doc.scrollHeight - (window.scrollY + window.innerHeight);
      setVisible(scrolled);
      setNearFooter(distanceToBottom < 360);
    }
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  function submit() {
    const v = value.trim();
    if (!v) return;
    window.location.assign(appUrl("/workers/new", { prompt: v }));
  }

  return (
    <AnimatePresence>
      {visible && !nearFooter ? (
        <motion.form
          aria-label="Tell Emily what to automate"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
          initial={{ opacity: 0, y: 20, scale: 0.98 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.98 }}
          transition={{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }}
          className="fixed inset-x-4 bottom-2 z-50 mx-auto flex max-w-[520px] items-center gap-1.5 rounded-[16px] bg-card/95 p-1.5 backdrop-blur md:bottom-3"
        >
          <button
            type="button"
            aria-label="Add context"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-secondary text-muted-foreground transition hover:bg-[var(--bg-3)] hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
          </button>
          <div className="relative min-w-0 flex-1">
            <div
              aria-hidden
              className="pointer-events-none absolute inset-0 truncate py-1.5 text-[13.5px] leading-5 text-foreground"
            >
              <Mirror text={value} matches={matches} />
            </div>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Tell Emily what to automate..."
              className="relative h-8 w-full bg-transparent text-[13.5px] leading-5 placeholder:text-muted-foreground"
              style={value ? { color: "transparent", caretColor: "var(--text-primary)", WebkitTextFillColor: "transparent" } : undefined}
              aria-label="Describe the worker"
            />
          </div>
          <button
            type="submit"
            aria-label="Hire worker"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] text-white transition hover:-translate-y-px disabled:opacity-50"
            style={{ background: "var(--v3-accent)" }}
            disabled={!value.trim()}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </motion.form>
      ) : null}
    </AnimatePresence>
  );
}
