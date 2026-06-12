"use client";
import "../app/landing.css";
import { useEffect, useState } from "react";
import Link from "next/link";
import { ThemeModeButton } from "./ThemeModeButton";
import { WaitlistCTA } from "./WaitlistCTA";
import {
  AnalyticsLogo,
  ArrowSVG,
  ChatGPTSVG,
  CheckIcon,
  ClaudeSVG,
  ClockIcon,
  CodexSVG,
  CopySVG,
  CursorSVG,
  FileTextIcon,
  FolderIcon,
  GitHubSVG,
  GmailLogo,
  HubSpotLogo,
  LinkedInLogo,
  MailIcon,
  NotionLogo,
  PlugIcon,
  SalesforceLogo,
  SheetsLogo,
  ShieldIcon,
  SlackLogo,
  SparkIcon,
  TrendIcon,
  UsersIcon,
  WindsurfSVG,
} from "./landing-icons";

// Landing CTAs point at /login (lets the user choose Google or GitHub) instead
// of triggering one provider directly.
const SIGN_IN_HREF = "/login";

/* WorkerOS mark used as the agent avatar inside the Slack mock. Same glyph
   as the nav brand mark, on a near-black tile so it reads as the
   "@workeros" app icon in a channel. */
const WorkerOSMarkSVG = () => (
  <svg viewBox="0 0 100 100" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M32 26h20l22 22a3 3 0 0 1 0 4l-22 22H32a6 6 0 0 1-6-6V32a6 6 0 0 1 6-6z" />
  </svg>
);

const HashIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" aria-hidden="true">
    <path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18" />
  </svg>
);

const PlayIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="0" aria-hidden="true">
    <polygon points="6 4 20 12 6 20 6 4" />
  </svg>
);

const FoundersIncSVG = () => (
  <svg className="ln-badge-logo" viewBox="0 0 96 96" fill="currentColor" aria-hidden="true">
    <path d="M55.9 17.1 19.8 38c-1.7 1-1.7 3.4 0 4.4l11.8 6.8 46.9-27.1V10.6c0-2.7-2.9-4.4-5.2-3.1L55.9 17.6v-.5Z" />
    <path d="M15.8 43.4 78.5 79.6v11.1c0 2.7-2.9 4.4-5.2 3.1L7.1 55.6c-2.7-1.6-2.7-5.4 0-7l8.7-5.2Z" />
    <path d="M52.7 43.3 78.5 28.4v38.5L52.7 52c-3.3-1.9-3.3-6.8 0-8.7Z" />
  </svg>
);

/* ── Hero Slack thread mock (the one outcome) ──────────────────────────
   A faithful, designed-from-scratch Slack-style thread in the engine tokens
   (warm paper, near-black ink, rounded). NOT a screenshot, NOT interactive.
   Content is the spec's exact "research these 5 inbound leads" exchange. */
/* Slack workspace-rail glyphs — decorative, render the unmistakable
   Slack left rail so the mock reads as Slack at a glance. */
const RailHomeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M3 10.5 12 4l9 6.5M5 9.5V20h14V9.5" />
  </svg>
);
const RailDMIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 5h16v11H8l-4 3z" />
  </svg>
);

function SlackThreadMock() {
  return (
    <div className="ln-slack" id="see-how-it-works" aria-label="How WorkerOS works in Slack">
      {/* Slack workspace rail (aubergine) */}
      <div className="ln-slack-rail" aria-hidden="true">
        <span className="ln-slack-rail-ws">A</span>
        <span className="ln-slack-rail-ico on"><RailHomeIcon /></span>
        <span className="ln-slack-rail-ico"><RailDMIcon /></span>
      </div>

      <div className="ln-slack-main">
      <div className="ln-slack-bar">
        <span className="ln-slack-chan">
          <HashIcon />revenue
          <span className="ln-slack-chan-meta">Acme · 28 members</span>
        </span>
        <span className="ln-slack-mock-tag">Designed preview</span>
      </div>

      <div className="ln-slack-body">
        {/* The ask */}
        <div className="ln-slack-msg">
          <span className="ln-slack-av user">JR</span>
          <div className="ln-slack-bd">
            <div className="ln-slack-meta">
              <b>Jordan Rivera</b>
              <span className="ln-slack-time">1:46 PM</span>
            </div>
            <div className="ln-slack-text">
              <span className="ln-slack-mention">@workeros</span> research these 5
              inbound leads before my 2pm calls
            </div>
          </div>
        </div>

        {/* The delivery */}
        <div className="ln-slack-msg">
          <span className="ln-slack-av bot"><WorkerOSMarkSVG /></span>
          <div className="ln-slack-bd">
            <div className="ln-slack-meta">
              <b>WorkerOS</b>
              <span className="ln-slack-app">APP</span>
              <span className="ln-slack-time">1:47 PM</span>
            </div>
            <div className="ln-slack-text"><b>Done.</b></div>

            <div className="ln-slack-sub">Created</div>
            <div className="ln-slack-files">
              <div className="ln-slack-file">
                <span className="ln-slack-file-ic"><FileTextIcon /></span>
                <div className="ln-slack-file-id">
                  <div className="ln-slack-file-nm">lead-brief.md</div>
                  <div className="ln-slack-file-mt">Markdown · 6.2 KB · 5 leads</div>
                </div>
                <span className="ln-slack-file-open">Open<ArrowSVG /></span>
              </div>
              <div className="ln-slack-created">
                <div className="ln-slack-created-row"><span className="ln-slack-dot"><CheckIcon /></span>3 follow-up drafts</div>
                <div className="ln-slack-created-row"><span className="ln-slack-dot"><CheckIcon /></span>HubSpot score updates</div>
              </div>
            </div>

            <div className="ln-slack-approval">
              <div className="ln-slack-sub ln-slack-sub-wait">Waiting for approval</div>
              <div className="ln-slack-approve-row">
                <span className="ln-slack-approve-ic"><MailIcon /></span>
                <span className="ln-slack-approve-tx">Send 3 external replies</span>
                <span className="ln-slack-approve-btn"><CheckIcon />Approve</span>
              </div>
            </div>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

/* Nav scroll docking */
function useNavScroll() {
  useEffect(() => {
    const navEl = document.getElementById("lnNav");
    if (!navEl) return;
    const nav = navEl;
    let lastY = window.scrollY || 0;
    let ticking = false;
    const TOP = 10, DELTA = 6;
    function apply() {
      ticking = false;
      const y = window.scrollY || 0;
      const docked = y > TOP;
      nav.classList.toggle("docked", docked);
      if (!docked) {
        nav.classList.remove("ln-hide");
      } else if (Math.abs(y - lastY) > DELTA) {
        if (y > lastY) nav.classList.add("ln-hide");
        else nav.classList.remove("ln-hide");
      }
      lastY = y;
    }
    function onScroll() {
      if (!ticking) { ticking = true; requestAnimationFrame(apply); }
    }
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    nav.addEventListener("focusin", () => nav.classList.remove("ln-hide"));
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
}

/* ── Section 2 data: outcome grid (departments, not fake live metrics) ── */
const OUTCOME_DEPTS: Array<{ icon: React.ReactNode; dept: string; items: string[] }> = [
  {
    icon: <TrendIcon />,
    dept: "Sales",
    items: ["Lead research", "CRM updates", "Follow-up drafts", "Account briefs"],
  },
  {
    icon: <UsersIcon />,
    dept: "Recruiting",
    items: ["Candidate sourcing", "Shortlists", "Outreach drafts", "Interview summaries"],
  },
  {
    icon: <FileTextIcon />,
    dept: "Ops",
    items: ["Invoice processing", "Weekly reports", "Data cleanup", "Vendor follow-ups"],
  },
  {
    icon: <SparkIcon />,
    dept: "Marketing",
    items: ["Competitor research", "Campaign briefs", "Content repurposing", "Market digests"],
  },
];

const OUTCOME_DEPT_HREF: Record<string, string> = {
  Sales: "/sales",
  Recruiting: "/recruiting",
  Marketing: "/marketing",
};

/* ── Section 3 data: comparison ──────────────────────────────────────── */
const COMPARE_ROWS = [
  { who: "ChatGPT", verb: "answers." },
  { who: "Zapier", verb: "connects." },
  { who: "Dashboards", verb: "show." },
  { who: "WorkerOS", verb: "does the workflow.", us: true },
];

/* ── Section 4 data: how it works (5 steps) ─────────────────────────── */
const HOW_STEPS = [
  {
    icon: <SlackLogo />,
    title: "Ask in Slack",
    body: "“Research these leads.”",
  },
  {
    icon: <PlugIcon />,
    title: "WorkerOS uses your tools",
    body: "Gmail, HubSpot, Sheets, Notion, Linear, Salesforce, and more.",
  },
  {
    icon: <FolderIcon />,
    title: "It applies your company context",
    body: "ICP, style guide, playbooks, pricing rules, OKRs, internal docs.",
  },
  {
    icon: <FileTextIcon />,
    title: "It creates the artifact",
    body: "Briefs, reports, drafts, sheets, tickets, summaries.",
  },
  {
    icon: <ShieldIcon />,
    title: "You approve what matters",
    body: "External emails, CRM changes, payments, posts.",
  },
];

/* ── Section 5 data: control ────────────────────────────────────────── */
const CONTROL_ITEMS = [
  { icon: <ShieldIcon />, title: "Approvals", body: "External actions pause before they ship." },
  { icon: <ClockIcon />, title: "Replay every run", body: "See inputs, steps, tools, cost, and output." },
  { icon: <FolderIcon />, title: "Context-bound", body: "Workers follow your ICP, style guide, playbooks, and rules." },
  { icon: <PlugIcon />, title: "Tool permissions", body: "Each worker only gets the tools it needs." },
];

/* ── Section 6 data: workers (employee cards) ───────────────────────── */
interface EmployeeCard {
  id: string;
  icon: React.ReactNode;
  name: string;
  trigger: string;
  tools: React.ReactNode[];
  body: string;
  approval: string;
  attention?: boolean;
}

const EMPLOYEES: EmployeeCard[] = [
  {
    id: "lead",
    icon: <MailIcon />,
    name: "Inbound Lead Researcher",
    trigger: "Runs when new leads enter HubSpot",
    tools: [<HubSpotLogo key="h" />, <LinkedInLogo key="l" />, <GmailLogo key="g" />],
    body: "Scores fit, researches accounts, drafts replies.",
    approval: "Asks before sending external emails",
  },
  {
    id: "invoice",
    icon: <FileTextIcon />,
    name: "Invoice Processor",
    trigger: "Runs when invoices hit Gmail",
    tools: [<GmailLogo key="g" />, <SheetsLogo key="s" />],
    body: "Extracts data, logs to Sheets, flags exceptions.",
    approval: "Auto-files low-risk invoices",
    attention: true,
  },
  {
    id: "digest",
    icon: <TrendIcon />,
    name: "Market Digest Writer",
    trigger: "Runs every morning",
    tools: [<SlackLogo key="sl" />, <SheetsLogo key="s" />],
    body: "Reads sources, writes a summary, posts to Slack.",
    approval: "Auto-posts to #market",
  },
];

/* ── Section 7 data: company context tree ───────────────────────────── */
const CONTEXT_LEAVES = [
  "ICP",
  "Sales playbook",
  "Style guide",
  "Pricing rules",
  "OKRs",
  "Customer notes",
  "Internal docs",
];
const CONTEXT_USERS = ["Lead Researcher", "Invoice Processor", "Market Digest Writer"];

/* ── Section 8 data: connections ────────────────────────────────────── */
const CONNECTION_TOOLS: Array<{ label: string; logo: React.ReactNode }> = [
  { label: "Slack", logo: <SlackLogo /> },
  { label: "Gmail", logo: <GmailLogo /> },
  { label: "HubSpot", logo: <HubSpotLogo /> },
  { label: "Salesforce", logo: <SalesforceLogo /> },
  { label: "Notion", logo: <NotionLogo /> },
  { label: "Sheets", logo: <SheetsLogo /> },
  { label: "Analytics", logo: <AnalyticsLogo /> },
];

export function LandingBody() {
  useNavScroll();

  const [copied, setCopied] = useState(false);
  const CMD = "npx -y @floomhq/workeros";
  async function copyCmd() {
    try {
      await navigator.clipboard.writeText(CMD);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch { /* ignore */ }
  }

  return (
    <>
      <nav className="ln-nav" id="lnNav" aria-label="Main navigation">
        <Link href="/" className="ln-brand">
          <span className="ln-mark" aria-hidden="true" />
          Floom <span style={{ color: "var(--ink-mute)", fontWeight: 450, marginLeft: 4 }}>/ workeros</span>
        </Link>
        <div className="ln-right">
          <a
            href="https://github.com/floomhq/workeros"
            target="_blank"
            rel="noopener noreferrer"
            className="ln-link"
          >
            Docs
          </a>
          <a
            href="https://github.com/floomhq/workeros"
            target="_blank"
            rel="noopener noreferrer"
            className="ln-gh-link"
            aria-label="GitHub"
          >
            <GitHubSVG />
          </a>
          <ThemeModeButton />
          <a href={SIGN_IN_HREF} className="ln-cta">Sign in</a>
        </div>
      </nav>

      <main id="flm-main">
        {/* SECTION 1 — HERO (one outcome only) */}
        <section className="lp1 ln-hero-section">
          <div className="ln-hero ln-rise ln-rise-1">
            <div className="ln-badge">
              <span className="ln-badge-k">Backed by</span>
              <span className="ln-badge-v">
                <FoundersIncSVG />
                Founders Inc
              </span>
            </div>

            <h1 className="ln-h1">Hire AI workers<br />that finish business work.</h1>

            <p className="ln-sub">
              WorkerOS lives in Slack, connects to your tools, uses your company
              context, and returns finished artifacts: lead briefs, reports,
              drafts, sheets, tickets, and more.
            </p>

            <div className="ln-ctas">
              <WaitlistCTA source="homepage-hero" />
              <a href="#see-how-it-works" className="ln-secondary-btn">
                <PlayIcon />
                See how it works
              </a>
            </div>
          </div>

          <div className="ln-hero-visual ln-rise ln-rise-2">
            <SlackThreadMock />
          </div>
        </section>

        {/* SECTION 2 — OUTCOME GRID (departments) */}
        <section className="ln-outcome-sec lp1" aria-label="What WorkerOS ships">
          <div className="ln-sec-head">
            <h2>WorkerOS ships the work your team keeps delaying.</h2>
          </div>
          <div className="ln-outcome-grid">
            {OUTCOME_DEPTS.map((d) => {
              const href = OUTCOME_DEPT_HREF[d.dept];
              const inner = (
                <>
                  <div className="ln-og-head">
                    <span className="ln-og-ic">{d.icon}</span>
                    <span className="ln-og-dept">{d.dept}</span>
                    {href && <span className="ln-og-arrow"><ArrowSVG /></span>}
                  </div>
                  <ul className="ln-og-items">
                    {d.items.map((it) => (
                      <li key={it}>{it}</li>
                    ))}
                  </ul>
                </>
              );
              return href ? (
                <Link key={d.dept} href={href} className="ln-og-card ln-og-link">
                  {inner}
                </Link>
              ) : (
                <div key={d.dept} className="ln-og-card">{inner}</div>
              );
            })}
          </div>
        </section>

        {/* SECTION 3 — COMPARISON */}
        <section className="ln-compare-sec lp1" aria-label="Why WorkerOS exists">
          <div className="ln-sec-head">
            <h2>Not AI chat. Not automation glue.</h2>
          </div>
          <div className="ln-compare">
            {COMPARE_ROWS.map((r) => (
              <div key={r.who} className={"ln-compare-row" + (r.us ? " us" : "")}>
                <span className="ln-compare-who">{r.who}</span>
                <span className="ln-compare-verb">{r.verb}</span>
              </div>
            ))}
          </div>
          <p className="ln-compare-sub">
            It pulls the data, applies your company context, creates the artifact,
            updates the tool, and asks before risky actions.
          </p>
        </section>

        {/* SECTION 4 — HOW IT WORKS (5 steps) */}
        <section className="ln-how lp1" aria-label="How it works">
          <div className="ln-sec-head">
            <div className="ln-ft-eye">How it works</div>
            <h2>Ask once. Get finished work back.</h2>
          </div>
          <div className="ln-flow">
            {HOW_STEPS.map((s, i) => (
              <div key={s.title} className="ln-flow-step">
                <div className="ln-flow-top">
                  <span className="ln-flow-num">{i + 1}</span>
                  <span className="ln-flow-ic">{s.icon}</span>
                </div>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* SECTION 5 — TRUST / CONTROL */}
        <section className="ln-control-sec lp1" aria-label="Control">
          <div className="ln-sec-head">
            <div className="ln-ft-eye">Control</div>
            <h2>It does the work. You stay in control.</h2>
          </div>
          <div className="ln-control-grid">
            {CONTROL_ITEMS.map((c) => (
              <div key={c.title} className="ln-control-item">
                <span className="ln-control-ic">{c.icon}</span>
                <div className="ln-control-tx">
                  <h3>{c.title}</h3>
                  <p>{c.body}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* SECTION 6 — WORKERS (employee cards) */}
        <section className="ln-team lp1" aria-label="Workers">
          <div className="ln-sec-head">
            <div className="ln-ft-eye">Workers</div>
            <h2>A worker is a repeatable job.</h2>
            <p>
              Give it a trigger, tools, company context, and an approval policy.
              It runs whenever the work comes up.
            </p>
          </div>

          <div className="ln-emps">
            {EMPLOYEES.map((e) => (
              <div key={e.id} className={"ln-emp" + (e.attention ? " att" : "")}>
                <div className="ln-emp-head">
                  <span className="ln-emp-ic">{e.icon}</span>
                  <div className="ln-emp-id">
                    <div className="ln-emp-nm">{e.name}</div>
                    <div className="ln-emp-trig"><ClockIcon />{e.trigger}</div>
                  </div>
                </div>
                <div className="ln-emp-result">
                  <span className="ln-emp-result-k">What it does</span>
                  <p>{e.body}</p>
                </div>
                <div className="ln-emp-meta">
                  <div className="ln-emp-tools" aria-label="Tools">
                    {e.tools.map((t, i) => (
                      <span key={i} className="ln-emp-tool">{t}</span>
                    ))}
                  </div>
                </div>
                <div className="ln-emp-approval">
                  <ShieldIcon />
                  {e.approval}
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* SECTION 7 — COMPANY CONTEXT (tree) */}
        <section className="ln-ctx lp1" aria-label="Company context">
          <div className="ln-ctx-grid">
            <div className="ln-ctx-txt">
              <div className="ln-ft-eye">Company context</div>
              <h2>Your company brain, used on every run.</h2>
              <p>
                WorkerOS does not start from zero. Every worker can use your
                company context: ICP, CRM playbook, voice guide, pricing rules,
                OKRs, customer notes, and internal docs.
              </p>
            </div>
            <div className="ln-ctx-vis">
              <div className="ln-ftv-bar">
                <i /><i /><i />
                <span>workeros.floom.dev/context</span>
              </div>
              <div className="ln-ctx-tree">
                <div className="ln-ctx-root">
                  <span className="ln-ctx-root-ic"><FolderIcon /></span>
                  Company context
                </div>
                <div className="ln-ctx-leaves">
                  {CONTEXT_LEAVES.map((l) => (
                    <div key={l} className="ln-ctx-leaf">
                      <FileTextIcon />
                      {l}
                    </div>
                  ))}
                </div>
                <div className="ln-ctx-usedby">
                  <span className="ln-ctx-usedby-k">Used by</span>
                  <div className="ln-ctx-usedby-rows">
                    {CONTEXT_USERS.map((u) => (
                      <span key={u} className="ln-ctx-worker">
                        <SparkIcon />
                        {u}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* SECTION 8 — CONNECTIONS (short) */}
        <section className="ln-conn lp1" aria-label="Connections">
          <div className="ln-sec-head">
            <div className="ln-ft-eye">Connections</div>
            <h2>Connect the tools you already use.</h2>
            <p>
              WorkerOS works across Slack, Gmail, HubSpot, Salesforce, Notion,
              Sheets, Linear, and your internal tools.
            </p>
          </div>
          <div className="ln-conn-logos">
            {CONNECTION_TOOLS.map((t) => (
              <span key={t.label} className="ln-conn-cell">
                <span className="ln-conn-logo">{t.logo}</span>
                {t.label}
              </span>
            ))}
          </div>
          <p className="ln-conn-trust">
            No secrets in code. No broken cron jobs. No copy-pasting between tabs.
          </p>
        </section>

        {/* SECTION 9 — DEVELOPERS / MCP (the only place MCP lives) */}
        <section className="ln-dev lp1" aria-label="For developers">
          <div className="ln-dev-txt">
            <div className="ln-ft-eye">For developers</div>
            <h2>Built for teams that already use agents.</h2>
            <p>
              Run WorkerOS from Claude, Cursor, Codex, or your own agents via MCP.
              Give agents access to approved workers, tools, and company context
              without exposing everything.
            </p>
            <div className="ln-dev-logos" aria-label="Works in">
              <span className="ln-logo-cell"><ClaudeSVG />Claude</span>
              <span className="ln-logo-cell"><ChatGPTSVG />ChatGPT</span>
              <span className="ln-logo-cell"><CursorSVG />Cursor</span>
              <span className="ln-logo-cell"><CodexSVG />Codex</span>
              <span className="ln-logo-cell"><WindsurfSVG />Windsurf</span>
            </div>
          </div>
          <div className="ln-dev-side">
            <button
              type="button"
              className={"ln-cmd" + (copied ? " copied" : "")}
              onClick={copyCmd}
              aria-label="Copy the MCP install command"
            >
              <span className="ln-cmd-pr">$</span>
              <code>{CMD}</code>
              <CopySVG />
              <span className="ln-cmd-ok" aria-hidden="true">Copied</span>
            </button>
            <a
              href="https://github.com/floomhq/workeros"
              target="_blank"
              rel="noopener noreferrer"
              className="ln-ft-lnk"
            >
              MCP reference
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="14" height="14" aria-hidden="true">
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            </a>
          </div>
        </section>

        {/* SECTION 10 — FINAL CTA */}
        <section className="ln-cta-section lp1">
          <h2>Put your first AI worker to work.</h2>
          <p className="ln-cta-sub">
            Pick one repeatable job. Connect the tools. Set the approval policy.
            Get finished work back in Slack.
          </p>
          <div className="ln-ctas" style={{ marginTop: 34 }}>
            <WaitlistCTA source="homepage-footer" />
            <a href="#see-how-it-works" className="ln-secondary-btn">
              <PlayIcon />
              See how it works
            </a>
          </div>
        </section>
      </main>

      <footer className="ln-footer">
        <div className="ln-footer-in">
          <div className="ln-footer-brand">WorkerOS<span className="cp">© 2026 · Built with care in San Francisco</span></div>
          <div className="ln-footer-col">
            <h3>Product</h3>
            <a href={SIGN_IN_HREF}>Sign in</a>
            <a href="https://github.com/floomhq/workeros" target="_blank" rel="noopener noreferrer">Docs</a>
            <a href="https://github.com/floomhq/workeros" target="_blank" rel="noopener noreferrer">GitHub</a>
          </div>
          <div className="ln-footer-col">
            <h3>For your team</h3>
            <Link href="/marketing">Marketing</Link>
            <Link href="/sales">Sales</Link>
            <Link href="/recruiting">Recruiting</Link>
            <Link href="/support">Support</Link>
          </div>
          <div className="ln-footer-col">
            <h3>Floom</h3>
            <a href="https://skills.floom.dev" target="_blank" rel="noopener noreferrer">Skills</a>
            <a href="https://floom.dev" target="_blank" rel="noopener noreferrer">Floom</a>
          </div>
          <div className="ln-footer-col">
            <h3>Legal</h3>
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
          </div>
          <div className="ln-footer-col">
            <h3>Connect</h3>
            <a href="https://www.linkedin.com/company/floomhq/" target="_blank" rel="noopener noreferrer">LinkedIn</a>
            <a href="https://x.com/floomhq" target="_blank" rel="noopener noreferrer">X</a>
          </div>
        </div>
      </footer>
    </>
  );
}
