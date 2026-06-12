"use client";

import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { ArrowUp } from "lucide-react";
import { appUrl } from "@/lib/app-url";
import { ToolLogo, hasLogo } from "./logos";

const ACCENT = "#3a6ea5";

const EXAMPLE_PROMPTS: Array<{ label: string; prompt: string; tool: string }> = [
  {
    label: "Weekly pipeline report",
    prompt:
      "Every Monday 9am, pull last week's pipeline from HubSpot and post a summary in #sales",
    tool: "hubspot",
  },
  {
    label: "Post-call follow-up",
    prompt:
      "After every Calendly call, draft a follow-up email using my CRM notes",
    tool: "gmail",
  },
  {
    label: "Morning lead research",
    prompt:
      "Each morning, research 5 new inbound leads before my first meeting",
    tool: "web",
  },
  {
    label: "Support inbox triage",
    prompt:
      "Triage our shared support inbox and tag urgent tickets in Slack",
    tool: "slack",
  },
];

// Known tool aliases recognized in prompt text. canonical is the display label.
// tool maps to the logos registry key (only when hasLogo() is true do we render
// an SVG; otherwise the chip is label-only, never a fake monogram).
const KNOWN_TOOLS: Array<{ keys: string[]; canonical: string; tool: string }> = [
  { keys: ["slack"], canonical: "Slack", tool: "slack" },
  { keys: ["whatsapp"], canonical: "WhatsApp", tool: "whatsapp" },
  { keys: ["discord"], canonical: "Discord", tool: "discord" },
  { keys: ["gmail"], canonical: "Gmail", tool: "gmail" },
  { keys: ["outlook"], canonical: "Outlook", tool: "outlook" },
  { keys: ["google calendar", "gcal"], canonical: "Google Calendar", tool: "calendar" },
  { keys: ["hubspot crm", "hubspot"], canonical: "HubSpot", tool: "hubspot" },
  { keys: ["google sheets", "sheets"], canonical: "Google Sheets", tool: "sheets" },
  { keys: ["notion"], canonical: "Notion", tool: "notion" },
  { keys: ["salesforce"], canonical: "Salesforce", tool: "salesforce" },
  { keys: ["intercom"], canonical: "Intercom", tool: "intercom" },
  { keys: ["github"], canonical: "GitHub", tool: "github" },
  { keys: ["linear"], canonical: "Linear", tool: "linear" },
  { keys: ["granola"], canonical: "Granola", tool: "granola" },
  { keys: ["calendly"], canonical: "Calendly", tool: "calendly" },
  { keys: ["zoom"], canonical: "Zoom", tool: "zoom" },
  { keys: ["asana"], canonical: "Asana", tool: "asana" },
  { keys: ["jira"], canonical: "Jira", tool: "jira" },
  { keys: ["airtable"], canonical: "Airtable", tool: "airtable" },
  { keys: ["google drive", "gdrive"], canonical: "Google Drive", tool: "drive" },
  { keys: ["claude code"], canonical: "Claude Code", tool: "claude-code" },
  { keys: ["claude"], canonical: "Claude", tool: "claude" },
  { keys: ["cursor"], canonical: "Cursor", tool: "cursor" },
  { keys: ["codex"], canonical: "Codex", tool: "codex" },
  { keys: ["copilot"], canonical: "GitHub Copilot", tool: "copilot" },
];

type Match = { start: number; end: number; canonical: string; tool: string };

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
          raw.push({ start: at, end: at + key.length, canonical: t.canonical, tool: t.tool });
        }
        i = at + key.length;
      }
    }
  }
  raw.sort((a, b) => (a.start - b.start) || (b.end - b.start - (a.end - a.start)));
  const out: Match[] = [];
  for (const m of raw) {
    const last = out[out.length - 1];
    if (!last || m.start >= last.end) out.push(m);
  }
  return out;
}

function uniqueTools(matches: Match[]): Match[] {
  const seen = new Set<string>();
  const out: Match[] = [];
  for (const m of matches) {
    if (seen.has(m.tool)) continue;
    seen.add(m.tool);
    out.push(m);
  }
  return out;
}

function HighlightedMirror({ text, matches }: { text: string; matches: Match[] }) {
  // Trailing newline forces the mirror to keep height for the in-progress line
  // (textareas render an extra phantom line for trailing \n).
  const safe = text.endsWith("\n") ? text + " " : text;
  if (!matches.length) {
    return <>{safe}</>;
  }
  const out: React.ReactNode[] = [];
  let cursor = 0;
  for (const m of matches) {
    if (m.start > cursor) out.push(safe.slice(cursor, m.start));
    out.push(
      <span
        key={`hl-${m.start}`}
        style={{
          background: "color-mix(in srgb, #3a6ea5 14%, transparent)",
          color: "#1f4870",
          borderRadius: "3px",
          padding: "0 2px",
          margin: "0 -1px",
          fontWeight: 500,
        }}
      >
        {safe.slice(m.start, m.end)}
      </span>,
    );
    cursor = m.end;
  }
  if (cursor < safe.length) out.push(safe.slice(cursor));
  return <>{out}</>;
}

export function HeroPromptComposer({
  onFocusedChange,
}: {
  onFocusedChange?: (focused: boolean) => void;
}) {
  const [value, setValue] = useState("");
  const [focused, setFocused] = useState(false);

  const matches = useMemo(() => detectMatches(value), [value]);
  const detected = useMemo(() => uniqueTools(matches), [matches]);

  function setFocusedAndBroadcast(v: boolean) {
    setFocused(v);
    onFocusedChange?.(v);
  }

  function submit() {
    const v = value.trim();
    if (!v) return;
    window.location.assign(appUrl("/workers/new", { prompt: v }));
  }

  return (
    <div className="mx-auto mt-8 w-full max-w-2xl">
      <motion.form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        onFocus={() => setFocusedAndBroadcast(true)}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget)) setFocusedAndBroadcast(false);
        }}
        animate={{ scale: focused ? 1.03 : 1 }}
        transition={{ type: "spring", stiffness: 80, damping: 22, mass: 1.1 }}
        className="group relative rounded-[18px] bg-card p-2"
        style={{
          border: focused ? `1.5px solid ${ACCENT}` : "1px solid var(--border-default)",
          boxShadow: focused
            ? `0 0 0 4px ${ACCENT}1a, 0 18px 40px -22px rgba(20,20,20,0.18)`
            : "0 1px 2px rgba(20,20,20,0.05), 0 6px 18px -14px rgba(20,20,20,0.10)",
          transition:
            "border-color 220ms cubic-bezier(0.22,1,0.36,1), box-shadow 260ms cubic-bezier(0.22,1,0.36,1)",
        }}
      >
        <div className="relative">
          {/* Mirror layer renders the highlighted text behind the textarea.
              Font/size/padding/line-height MUST match the textarea exactly. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 px-3 pt-3 pb-2 text-left text-[15px] leading-relaxed text-foreground"
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              overflowWrap: "break-word",
            }}
          >
            <HighlightedMirror text={value} matches={matches} />
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
            placeholder="Every Monday, summarize last week's pipeline in #sales..."
            rows={3}
            className="relative w-full resize-none bg-transparent px-3 pt-3 pb-2 text-left text-[15px] leading-relaxed placeholder:text-muted-foreground/70 focus:outline-none"
            style={{
              color: "transparent",
              caretColor: "var(--ink)",
              WebkitTextFillColor: "transparent",
            }}
            aria-label="Describe what your AI worker should do"
          />
        </div>
        <div className="flex items-center justify-between gap-3 px-2 pb-1">
          {detected.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {detected.map((d) => (
                <span
                  key={d.tool}
                  className="inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[11px] font-medium"
                  style={{
                    borderColor: "color-mix(in srgb, #3a6ea5 26%, transparent)",
                    background: "color-mix(in srgb, #3a6ea5 8%, transparent)",
                    color: "#1f4870",
                  }}
                  title={`Workeros recognises ${d.canonical}`}
                >
                  {hasLogo(d.tool) && (
                    <span className="inline-flex h-3 w-3 shrink-0 items-center justify-center [&>svg]:h-3 [&>svg]:w-3">
                      <ToolLogo name={d.tool} />
                    </span>
                  )}
                  {d.canonical}
                </span>
              ))}
            </div>
          ) : (
            <span className="hidden text-[11px] text-muted-foreground sm:inline">
              ⌘&thinsp;+&thinsp;Enter to hire
            </span>
          )}
          <motion.button
            type="submit"
            disabled={!value.trim()}
            aria-label="Hire this worker"
            whileHover={value.trim() ? { y: -1 } : undefined}
            whileTap={value.trim() ? { scale: 0.97 } : undefined}
            transition={{ type: "spring", stiffness: 320, damping: 22 }}
            className="group/cta inline-flex h-9 shrink-0 items-center gap-1.5 rounded-[10px] px-3.5 text-[13px] font-medium text-primary-foreground shadow-sm disabled:cursor-not-allowed disabled:opacity-40"
            style={{
              background: value.trim() ? ACCENT : "var(--primary)",
              transition: "background-color 240ms cubic-bezier(0.22,1,0.36,1)",
            }}
          >
            Hire this worker
            <ArrowUp className="h-3.5 w-3.5 transition-transform duration-200 group-hover/cta:-translate-y-0.5" />
          </motion.button>
        </div>
      </motion.form>

      <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
        {EXAMPLE_PROMPTS.map((p) => (
          <motion.button
            key={p.label}
            type="button"
            onClick={() => setValue(p.prompt)}
            whileHover={{ y: -1 }}
            whileTap={{ scale: 0.97 }}
            transition={{ type: "spring", stiffness: 320, damping: 22 }}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card py-1.5 pl-2.5 pr-3.5 text-[12px] font-medium text-foreground/85 transition-colors hover:border-foreground/30 hover:bg-secondary/60"
          >
            <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5">
              <ToolLogo name={p.tool} />
            </span>
            {p.label}
          </motion.button>
        ))}
      </div>
    </div>
  );
}
