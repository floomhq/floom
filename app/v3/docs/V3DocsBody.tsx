"use client";

/**
 * /v2/docs — docs as their own page on the v2 system. Quickstart-first,
 * sticky mini-TOC on desktop, code blocks in the spec grammar.
 */

import Link from "next/link";
import { useState } from "react";
import { motion } from "motion/react";
import { SlackLogo, WhatsAppLogo } from "@/components/landing-icons";
import { Hl, V3Shell } from "../V3Shell";
import "../theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const TOC = [
  ["quickstart", "Quickstart"],
  ["channels", "Install in your channel"],
  ["mcp", "Use from any agent (MCP)"],
  ["brain", "Company brain"],
  ["approvals", "Approvals"],
  ["faq", "FAQ"],
] as const;

function CopyLine({ text }: { text: string }) {
  return (
    <span className="flex items-center justify-between gap-3">
      <span>$ {text}</span>
      <button
        type="button"
        onClick={() => navigator.clipboard?.writeText(text)}
        className="shrink-0 rounded-[7px] border border-border bg-card px-2 py-0.5 font-sans text-[10.5px] font-medium text-muted-foreground hover:text-foreground"
      >
        Copy
      </button>
    </span>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <pre className="overflow-x-auto rounded-[10px] bg-secondary px-4 py-3 font-mono text-[12px] leading-relaxed text-foreground/85">
      {children}
    </pre>
  );
}

const MCP_TARGETS = [
  ["claude", "Claude Code"],
  ["cursor", "Cursor"],
  ["vscode", "VS Code"],
] as const;

function McpInstall() {
  const [target, setTarget] = useState<(typeof MCP_TARGETS)[number][0]>("claude");
  return (
    <div>
      <div className="mb-2 flex gap-1.5">
        {MCP_TARGETS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTarget(id)}
            className="rounded-full px-3 py-1 text-[12px] font-medium transition-colors"
            style={
              target === id
                ? { background: "var(--v3-sel)", color: "var(--v3-accent)" }
                : { background: "var(--bg-2)", color: "var(--text-muted)" }
            }
          >
            {label}
          </button>
        ))}
      </div>
      <Code>
        <CopyLine text={`npx -y @floomhq/workeros mcp install --target ${target}`} />
      </Code>
    </div>
  );
}

function H2({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h2 id={id} className="mb-3 mt-12 scroll-mt-24 text-[22px] font-semibold tracking-[-0.018em] first:mt-0">
      {children}
    </h2>
  );
}

export function V3DocsBody() {
  return (
    <V3Shell active="docs">


        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE }}
          className="pb-10 pt-12"
        >
          <h1 className="text-[36px] font-semibold tracking-[-0.028em]">Docs</h1>
          <p className="mt-2 max-w-[480px] text-[14px] text-muted-foreground">
            Everything you need to hire your first <Hl>worker</Hl> and keep it on the record.
          </p>
        </motion.div>

        <div className="grid gap-12 md:grid-cols-[180px_1fr]">
          {/* mini TOC */}
          <div className="hidden md:block">
            <div className="sticky top-8 flex flex-col gap-0.5 border-l border-border pl-4">
              {TOC.map(([id, label]) => (
                <a key={id} href={`#${id}`} className="py-1 text-[12.5px] text-muted-foreground transition-colors hover:text-foreground">
                  {label}
                </a>
              ))}
            </div>
          </div>

          {/* content */}
          <div className="min-w-0 max-w-[620px]">
            <H2 id="quickstart">Quickstart</H2>
            <ol className="flex flex-col gap-2.5 text-[13.5px] leading-relaxed text-foreground/85">
              <li><b className="font-semibold">1. Describe the job.</b> One sentence, plain English. Workeros recognises your tools as you type.</li>
              <li><b className="font-semibold">2. Review the draft.</b> Tools, schedule, approval rules and company brain, assembled for review. Edit anything, then hire.</li>
              <li><b className="font-semibold">3. Approve the first run.</b> The worker drafts, you approve. After that it runs in the background and asks before anything ships.</li>
            </ol>
            <div className="mt-4">
              <Link href="/v3" className="text-[13px] font-medium" style={{ color: "var(--v2-accent)" }}>Hire your first worker →</Link>
            </div>

            <H2 id="channels">Install in your channel</H2>
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              You never have to open the dashboard. Install Workeros where your team already talks and hire, approve, and redirect from there.
            </p>
            <div className="mt-2 flex flex-col">
              <div className="flex items-center gap-3 border-b border-border-soft py-3.5 last:border-0">
                <span className="[&_svg]:h-4 [&_svg]:w-4"><SlackLogo /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">Slack</div>
                  <div className="text-[12px] text-muted-foreground">Workspace install. Workers post drafts and approval buttons in your channels.</div>
                </div>
                <Link href="/login?install=slack" className="rounded-[8px] border border-border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-secondary">Install</Link>
              </div>
              <div className="flex items-center gap-3 border-b border-border-soft py-3.5 last:border-0">
                <span className="[&_svg]:h-4 [&_svg]:w-4"><WhatsAppLogo /></span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">WhatsApp</div>
                  <div className="text-[12px] text-muted-foreground">Personal or shared number. Summaries and approvals as messages.</div>
                </div>
                <Link href="/login?install=whatsapp" className="rounded-[8px] border border-border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-secondary">Install</Link>
              </div>
              <div className="flex items-center gap-3 border-b border-border-soft py-3.5 last:border-0">
                <span className="flex h-4 w-4 items-center justify-center rounded-[4px] bg-primary font-mono text-[7.5px] font-bold text-primary-foreground">&gt;_</span>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">CLI</div>
                  <div className="text-[12px] text-muted-foreground">Pair from your terminal with a one-time code.</div>
                </div>
                <Link href="/login?install=cli" className="rounded-[8px] border border-border bg-card px-2.5 py-1 text-[12px] font-medium hover:bg-secondary">Pair</Link>
              </div>
            </div>

            <H2 id="mcp">Use from any agent (MCP)</H2>
            <p className="mb-3 text-[13.5px] leading-relaxed text-muted-foreground">
              Workeros speaks MCP. Add it to Claude Code, Cursor, Codex, or any client and drive workers from where you already work.
            </p>
            <McpInstall />
            <p className="mt-2 text-[12px] text-muted-foreground">Ships the `workeros-mcp` stdio server from the `@floomhq/workeros` package.</p>
            <p className="mt-3 text-[12.5px] text-muted-foreground">
              Then: &quot;run client-follow-up for the Acme call&quot; from your agent. The run lands on the record like any other.
            </p>

            <H2 id="brain">Company brain</H2>
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              Drop in SOPs, pricing sheets, tone guides, links. Every worker brief comes pre-loaded with what your team already knows, and each run logs which files it used so you can audit the why behind every output.
            </p>

            <H2 id="approvals">Approvals</H2>
            <p className="text-[13.5px] leading-relaxed text-muted-foreground">
              Anything that leaves the building (emails, CRM writes, posts) is held for your yes by default. Approve in Slack, WhatsApp, or the app. You can relax the gate per worker once you trust it.
            </p>

            <H2 id="faq">FAQ</H2>
            <div className="flex flex-col gap-4">
              {[
                ["Which models does it use?", "Any. Bring your own keys or use the defaults. Model choice is per worker."],
                ["Where do my tokens live?", "Encrypted at rest, used only for the workers you build. Revoke at the source any time."],
                ["Can my team share workers?", "Yes. Workspaces share workers, brain, and the run record."],
                ["What does it cost?", "Workeros Cloud is in early access. Pricing is being finalised with the first teams."],
              ].map(([q, a]) => (
                <div key={q}>
                  <div className="text-[13.5px] font-semibold">{q}</div>
                  <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{a}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
    </V3Shell>
  );
}
