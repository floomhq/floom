"use client";

// #1362 — Activation / empty-state panel shown on the Overview when the
// workspace has no workers and no runs. Renders a prompt composer (redirect to
// Emily create flow) and example worker cards.
import { useRouter } from "next/navigation";
import { useState, useRef } from "react";
import { ArrowRight, Plug } from "lucide-react";
import Link from "next/link";
import { PromptChips } from "@/components/PromptChips";

// Example worker cards — mirrors the CREATE_EXAMPLES in EmilyChat.tsx.
// These are intentionally plain-text prompts so they route cleanly into
// /chat?mode=create&prime=<prompt> and hit the Emily compose flow.
export const EXAMPLE_WORKERS = [
  {
    label: "Granola → HubSpot daily",
    prompt: "Summarise my Granola meetings and post action items to HubSpot CRM daily",
  },
  {
    label: "GitHub PR digest 9am",
    prompt: "Every morning at 9am, send me a digest of my unread GitHub PRs and open issues",
  },
  {
    label: "Invoice → Sheets",
    prompt:
      "Process any new email in label 'invoices', extract total amount, and add a row to Google Sheets",
  },
  {
    label: "HubSpot deal → Slack",
    prompt: "When a new deal is created in HubSpot, send a Slack message to #sales-channel",
  },
] as const;

function navigateToCreate(router: ReturnType<typeof useRouter>, prompt: string) {
  router.push(`/chat?mode=create&prime=${encodeURIComponent(prompt)}`);
}

function PromptComposer({ onSubmit }: { onSubmit: (prompt: string) => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] shadow-[var(--shadow-card)] p-4 space-y-3"
    >
      <textarea
        ref={inputRef}
        rows={4}
        placeholder="Create me: a worker that…"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            const trimmed = value.trim();
            if (trimmed) onSubmit(trimmed);
          }
        }}
        className="w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-[var(--text-muted)]"
      />
      <PromptChips prompt={value} />
      <div className="h-px bg-[var(--border-default)]" />
      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          disabled={!value.trim()}
          className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--accent)] px-4 text-sm font-medium text-[var(--accent-foreground)] opacity-90 transition-opacity hover:opacity-100 disabled:opacity-30"
        >
          Hire worker
          <ArrowRight className="size-3.5" />
        </button>
        <kbd
          className="hidden sm:inline-flex items-center gap-0.5 rounded [border:var(--bd-card)] bg-[var(--bg-2)] px-1.5 py-1 text-[10px] font-mono text-[var(--text-muted)]"
          aria-hidden="true"
        >
          ↵
        </kbd>
      </div>
    </form>
  );
}

function ExampleWorkerCard({ label, prompt, onSelect }: { label: string; prompt: string; onSelect: (p: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onSelect(prompt)}
      className="flex flex-col items-start gap-1 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] px-4 py-3 text-left transition-colors hover:bg-[var(--active-nav-bg)]"
    >
      <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
      <span className="text-xs text-[var(--text-muted)] line-clamp-2 leading-relaxed">
        {prompt}
      </span>
      <PromptChips prompt={prompt} className="mt-0.5" />
    </button>
  );
}

export function ActivationPanel({ onFocusEmily }: { onFocusEmily?: () => void }) {
  const router = useRouter();

  function handlePrompt(prompt: string) {
    navigateToCreate(router, prompt);
  }

  return (
    <div className="flex flex-col items-center justify-center gap-8 py-10 px-4 w-full">
      {/* Headline */}
      <div className="text-center space-y-2 max-w-xl">
        <h1 className="text-2xl font-semibold tracking-tight text-[var(--text-primary)] leading-tight">
          What would you like to automate?
        </h1>
        <p className="text-sm text-[var(--text-muted)] leading-relaxed">
          Describe the job in plain English. Emily drafts the worker, picks the right
          integrations, and opens the editor so you can review before running.
        </p>
      </div>

      {/* Prompt composer */}
      <div className="w-full max-w-2xl">
        <PromptComposer onSubmit={handlePrompt} />
      </div>

      {/* Example cards */}
      <div className="w-full max-w-2xl space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-[var(--text-muted)]">
          Or start from a template
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {EXAMPLE_WORKERS.map((ex) => (
            <ExampleWorkerCard
              key={ex.label}
              label={ex.label}
              prompt={ex.prompt}
              onSelect={handlePrompt}
            />
          ))}
        </div>
      </div>

      {/* Connect your apps nudge */}
      <div className="w-full max-w-2xl">
        <Link
          href="/connections"
          className="flex items-center gap-3 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] px-4 py-3 transition-colors hover:bg-[var(--active-nav-bg)]"
        >
          <span className="inline-flex shrink-0 items-center justify-center size-8 rounded-[var(--radius-squircle)] bg-[var(--accent-soft)] text-[var(--accent)]">
            <Plug className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-[var(--text-primary)]">Connect your apps</p>
            <p className="text-xs text-[var(--text-muted)]">
              Link Gmail, Slack, HubSpot, and more so workers can act on your behalf.
            </p>
          </div>
          <ArrowRight className="size-4 shrink-0 text-[var(--text-muted)]" />
        </Link>
      </div>

      {/* Emily shortcut */}
      {onFocusEmily && (
        <p className="text-sm text-[var(--text-muted)]">
          Or{" "}
          <button
            type="button"
            onClick={onFocusEmily}
            className="text-[var(--accent)] hover:underline font-medium"
          >
            ask Emily
          </button>{" "}
          and describe what you want. She will build it for you.
        </p>
      )}
    </div>
  );
}
