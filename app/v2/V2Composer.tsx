"use client";

/**
 * V2Composer — the prompt composer in the FINAL wireframe design system.
 * Fork of landing-ref/HeroPromptComposer for the /v2 preview: spec blue
 * (#3E6FE0 via --v2-accent), flat (hairline + focus ring, no shadows),
 * framer-motion focus scale, optional slim variant and channel-entry row.
 * Tracker #7 (old-blue focus) and #11 (heavy duplicate composer) close here.
 */

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { ArrowUp } from "lucide-react";
import { SlackLogo, WhatsAppLogo } from "@/components/landing-icons";

const KNOWN_TOOLS: Array<{ keys: string[]; canonical: string }> = [
  { keys: ["slack"], canonical: "Slack" },
  { keys: ["whatsapp"], canonical: "WhatsApp" },
  { keys: ["gmail"], canonical: "Gmail" },
  { keys: ["google calendar", "gcal"], canonical: "Google Calendar" },
  { keys: ["hubspot crm", "hubspot"], canonical: "HubSpot" },
  { keys: ["google sheets", "sheets"], canonical: "Google Sheets" },
  { keys: ["notion"], canonical: "Notion" },
  { keys: ["granola"], canonical: "Granola" },
  { keys: ["github"], canonical: "GitHub" },
  { keys: ["linear"], canonical: "Linear" },
];

type Match = { start: number; end: number; canonical: string };

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
        if (!word.test(before) && !word.test(after)) {
          raw.push({ start: at, end: at + key.length, canonical: t.canonical });
        }
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
    out.push(
      <span key={`hl-${m.start}`} className="v2-hl">
        {safe.slice(m.start, m.end)}
      </span>,
    );
    cursor = m.end;
  }
  if (cursor < safe.length) out.push(safe.slice(cursor));
  return <>{out}</>;
}

const PILLS: Array<{ label: string; prompt: string }> = [
  { label: "Pipeline report", prompt: "Every Monday 9am, pull last week's pipeline from HubSpot and post a summary in #sales" },
  { label: "Post-call follow-up", prompt: "After every call, draft a follow-up email using my CRM notes" },
  { label: "Lead research", prompt: "Each morning, research 5 new inbound leads before my first meeting" },
];

export function V2Composer({
  slim = false,
  channels = false,
  pills = false,
  placeholder = "Every Monday, summarise last week's pipeline in #sales…",
}: {
  slim?: boolean;
  channels?: boolean;
  pills?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);
  const router = useRouter();
  const matches = useMemo(() => detectMatches(value), [value]);

  function submit() {
    const v = value.trim();
    if (!v) return;
    router.push(`/app/workers/new?prompt=${encodeURIComponent(v)}`);
  }

  return (
    <div className={`mx-auto w-full ${slim ? "max-w-[480px]" : "max-w-[600px]"}`}>
      <motion.form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onFocus={() => setFocused(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false);
        }}
        animate={{ scale: focused ? 1.015 : 1 }}
        transition={{ type: "spring", stiffness: 140, damping: 22 }}
        className="rounded-[16px] bg-card p-3.5 text-left"
        style={{
          boxShadow: focused
            ? "0 0 0 1.5px var(--v2-accent)"
            : "0 0 0 1px var(--border-default)",
          transition: "box-shadow 180ms cubic-bezier(0.22,1,0.36,1)",
        }}
      >
        <div className="relative">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 whitespace-pre-wrap break-words px-1.5 pb-4 pt-1 text-left text-[14px] leading-relaxed text-foreground"
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
            rows={slim ? 1 : 2}
            className="relative w-full resize-none bg-transparent px-1.5 pb-4 pt-1 text-left text-[14px] leading-relaxed placeholder:text-muted-foreground focus:outline-none"
            style={{ color: "transparent", caretColor: "var(--text-primary)", WebkitTextFillColor: "transparent" }}
            aria-label="Describe what your AI worker should do"
          />
        </div>
        <div className="flex items-center justify-between border-t border-border-soft px-1.5 pt-2.5">
          <span className="hidden font-mono text-[11px] text-muted-foreground sm:inline">⌘ ↵</span>
          <motion.button
            type="submit"
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.98 }}
            className="flex items-center gap-1.5 rounded-[10px] px-3.5 py-2 text-[13px] font-medium text-white"
            style={{ background: "var(--v2-accent)" }}
          >
            Hire this worker
            <ArrowUp className="h-3.5 w-3.5" />
          </motion.button>
        </div>
      </motion.form>

      {pills && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
          {PILLS.map((p) => (
            <motion.button
              key={p.label}
              type="button"
              onClick={() => setValue(p.prompt)}
              whileHover={{ y: -1 }}
              whileTap={{ scale: 0.97 }}
              className="rounded-full border border-border bg-card px-3 py-1.5 text-[12px] font-medium text-foreground/75 transition-colors hover:border-[var(--v2-accent)] hover:text-foreground"
            >
              {p.label}
            </motion.button>
          ))}
        </div>
      )}

      {channels && (
        <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-[12px] text-muted-foreground">
          <span>or hire straight from</span>
          <a
            href="/login?install=slack"
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 font-medium text-foreground/80 transition-colors hover:border-[var(--v2-accent)] hover:text-foreground"
          >
            <span className="[&_svg]:h-3 [&_svg]:w-3"><SlackLogo /></span>Slack
          </a>
          <a
            href="/login?install=whatsapp"
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 font-medium text-foreground/80 transition-colors hover:border-[var(--v2-accent)] hover:text-foreground"
          >
            <span className="[&_svg]:h-3 [&_svg]:w-3"><WhatsAppLogo /></span>WhatsApp
          </a>
          <a
            href="/v2/docs#mcp"
            className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 font-mono text-[11px] font-medium text-foreground/80 transition-colors hover:border-[var(--v2-accent)] hover:text-foreground"
          >
            <span className="flex h-3.5 w-3.5 items-center justify-center rounded-[4px] bg-primary font-mono text-[7px] font-bold text-primary-foreground">&gt;_</span>
            MCP
          </a>
          <span className="text-muted-foreground/70">· no dashboard needed</span>
        </div>
      )}
    </div>
  );
}
