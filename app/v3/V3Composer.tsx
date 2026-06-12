"use client";

/**
 * V3Composer — the jewel. One saturated object on the page.
 * Bigger presence than v2: taller, more inner air, the button is the only
 * blue at rest. Flat at rest, accent ring on focus. Tool names highlight
 * as you type. No channel row, no extra chrome.
 */

import { useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { ArrowUp } from "lucide-react";
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
  placeholder = "Every Monday, summarise last week's pipeline in #sales…",
  fillSignal,
}: {
  placeholder?: string;
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
      className="mx-auto w-full max-w-[640px] rounded-[20px] bg-secondary p-5 text-left"
      style={{
        boxShadow: focused ? "0 0 0 1.5px var(--v3-accent)" : "none",
        transition: "box-shadow 180ms cubic-bezier(0.22,1,0.36,1)",
      }}
    >
      <div className="relative">
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 whitespace-pre-wrap break-words px-1 pb-6 pt-1 text-left text-[15.5px] leading-relaxed text-foreground"
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
          rows={2}
          className="relative w-full resize-none bg-transparent px-1 pb-6 pt-1 text-left text-[15.5px] leading-relaxed placeholder:text-muted-foreground focus:outline-none"
          style={{ color: "transparent", caretColor: "var(--text-primary)", WebkitTextFillColor: "transparent" }}
          aria-label="Describe the job"
        />
      </div>
      <div className="flex items-center justify-end pt-1">
        <motion.button
          type="submit"
          whileHover={{ y: -1 }}
          whileTap={{ scale: 0.98 }}
          className="flex items-center gap-2 rounded-[12px] px-5 py-2.5 text-[14px] font-medium text-white"
          style={{ background: "var(--v3-accent)" }}
        >
          Hire
          <ArrowUp className="h-4 w-4" />
        </motion.button>
      </div>
    </motion.form>
  );
}
