"use client";

/**
 * /templates/submit — community publishing. A maker describes a worker (or
 * workspace); it's submitted for OUR review (status: pending) and only renders
 * in the catalog once approved. Posts via the marketplace route handler.
 */

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CATEGORIES } from "@/components/landing-ref/data";
import { V3Shell } from "../../V3Shell";
import "../../theme.css";

export function V3SubmitBody() {
  const [kind, setKind] = useState<"worker" | "workspace">("worker");
  const [title, setTitle] = useState("");
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [summary, setSummary] = useState("");
  const [details, setDetails] = useState("");
  const [tools, setTools] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "done" | "auth" | "error">("idle");

  const valid = title.trim().length >= 2 && summary.trim().length >= 2 && details.trim().length >= 10;

  async function submit() {
    if (!valid) return;
    setState("saving");
    try {
      const res = await fetch("/api/marketplace/submissions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          item_kind: kind,
          title,
          category,
          summary,
          tools: tools.split(",").map((t) => t.trim()).filter(Boolean),
          display: { summary },
          bundle: { prompt: details },
        }),
      });
      if (res.status === 401 || res.status === 403) return setState("auth");
      if (!res.ok) return setState("error");
      setState("done");
    } catch {
      setState("error");
    }
  }

  return (
    <V3Shell active="templates">
      <Link href="/templates" className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> All templates
      </Link>

      <div className="mx-auto max-w-[560px] pb-24 pt-10">
        <h1 className="text-[30px] font-semibold leading-[1.05] tracking-[-0.028em] sm:text-[36px]">
          Publish a worker
        </h1>
        <p className="mt-3 text-[14.5px] leading-relaxed text-muted-foreground">
          Describe a worker you&apos;ve built. We review every submission before it goes live in the
          marketplace — quality and safety first.
        </p>

        {state === "done" ? (
          <div className="mt-8 rounded-[14px] bg-secondary/50 p-6">
            <h2 className="text-[16px] font-semibold">Submitted for review</h2>
            <p className="mt-2 text-[13.5px] text-muted-foreground">
              Thanks. We&apos;ll review it and email you when it&apos;s approved. It appears in the
              catalog only after our review.
            </p>
            <Link href="/templates" className="mt-4 inline-block text-[13px] font-medium" style={{ color: "var(--v3-accent)" }}>
              Back to marketplace
            </Link>
          </div>
        ) : (
          <div className="mt-8 space-y-5">
            <div className="flex gap-2">
              {(["worker", "workspace"] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => setKind(k)}
                  className="rounded-full px-3.5 py-1.5 text-[12.5px] font-medium capitalize transition-colors"
                  style={kind === k ? { background: "var(--v3-accent)", color: "#fff" } : { background: "var(--bg-2)", color: "var(--text-muted)" }}
                >
                  {k}
                </button>
              ))}
            </div>

            <Field label="Name">
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Invoice Chaser" className={inputCls} />
            </Field>

            <Field label="Category">
              <select value={category} onChange={(e) => setCategory(e.target.value)} className={inputCls}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
            </Field>

            <Field label="One-line summary">
              <input value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="What it does, in a sentence." className={inputCls} />
            </Field>

            <Field label="What it does (details)">
              <textarea value={details} onChange={(e) => setDetails(e.target.value)} rows={4} placeholder="Describe the job, the trigger, the tools, the output." className={`${inputCls} resize-none`} />
            </Field>

            <Field label="Tools (comma-separated)">
              <input value={tools} onChange={(e) => setTools(e.target.value)} placeholder="Gmail, Notion, Slack" className={inputCls} />
            </Field>

            <div className="flex items-center gap-3 pt-1">
              <button
                onClick={submit}
                disabled={!valid || state === "saving"}
                className="inline-flex h-9 items-center rounded-[10px] px-4 text-[13px] font-medium text-white disabled:opacity-40"
                style={{ background: "var(--v3-accent)" }}
              >
                {state === "saving" ? "Submitting…" : "Submit for review"}
              </button>
              {state === "auth" && (
                <a href="/login?next=/templates/submit" className="text-[12.5px] underline" style={{ color: "var(--v3-accent)" }}>
                  Sign in to submit
                </a>
              )}
              {state === "error" && <span className="text-[12.5px] text-muted-foreground">Couldn&apos;t submit — try again.</span>}
            </div>
          </div>
        )}
      </div>
    </V3Shell>
  );
}

const inputCls = "w-full rounded-[10px] bg-secondary px-3 py-2.5 text-[13.5px] placeholder:text-muted-foreground focus:outline-none";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-[12px] font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
