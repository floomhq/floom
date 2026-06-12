"use client";
import "../app/landing.css";
import "../app/vertical.css";
import { WaitlistCTA } from "./WaitlistCTA";
import { VERTICALS } from "@/lib/verticals";
import type { Vertical } from "@/lib/verticals";
import {
  ArrowSVG,
  CheckIcon,
  ClockIcon,
  FileTextIcon,
  FolderIcon,
  MailIcon,
  PlugIcon,
  ShieldIcon,
} from "./landing-icons";

/* Local glyphs not in landing-icons (mirrors LandingBody's hero mock). */
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
const WorkerOSMarkSVG = () => (
  <svg viewBox="0 0 100 100" width="18" height="18" fill="currentColor" aria-hidden="true">
    <path d="M32 26h20l22 22a3 3 0 0 1 0 4l-22 22H32a6 6 0 0 1-6-6V32a6 6 0 0 1 6-6z" />
  </svg>
);
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

/* The hero demo: a Slack exchange for THIS team, returning finished work +
   one action held for approval. Same designed-mock spine as the homepage. */
function SlackThreadMock({ v }: { v: Vertical }) {
  const s = v.slack;
  return (
    <div className="ln-slack" id="see-how-it-works" aria-label={`How WorkerOS works for ${v.eyebrow}`}>
      <div className="ln-slack-rail" aria-hidden="true">
        <span className="ln-slack-rail-ws">A</span>
        <span className="ln-slack-rail-ico on"><RailHomeIcon /></span>
        <span className="ln-slack-rail-ico"><RailDMIcon /></span>
      </div>
      <div className="ln-slack-main">
      <div className="ln-slack-bar">
        <span className="ln-slack-chan"><HashIcon />{s.channel}<span className="ln-slack-chan-meta">Acme · 28 members</span></span>
        <span className="ln-slack-mock-tag">Designed preview</span>
      </div>

      <div className="ln-slack-body">
        <div className="ln-slack-msg">
          <span className="ln-slack-av user">{s.userInitials}</span>
          <div className="ln-slack-bd">
            <div className="ln-slack-meta">
              <b>{s.userName}</b>
              <span className="ln-slack-time">9:02 AM</span>
            </div>
            <div className="ln-slack-text">
              <span className="ln-slack-mention">@workeros</span> {s.ask}
            </div>
          </div>
        </div>

        <div className="ln-slack-msg">
          <span className="ln-slack-av bot"><WorkerOSMarkSVG /></span>
          <div className="ln-slack-bd">
            <div className="ln-slack-meta">
              <b>WorkerOS</b>
              <span className="ln-slack-app">APP</span>
              <span className="ln-slack-time">9:03 AM</span>
            </div>
            <div className="ln-slack-text"><b>{s.doneLine}</b></div>

            <div className="ln-slack-sub">Created</div>
            <div className="ln-slack-files">
              <div className="ln-slack-file">
                <span className="ln-slack-file-ic"><FileTextIcon /></span>
                <div className="ln-slack-file-id">
                  <div className="ln-slack-file-nm">{s.artifactName}</div>
                  <div className="ln-slack-file-mt">{s.artifactMeta}</div>
                </div>
                <span className="ln-slack-file-open">Open<ArrowSVG /></span>
              </div>
              <div className="ln-slack-created">
                {s.created.map((c) => (
                  <div key={c} className="ln-slack-created-row">
                    <span className="ln-slack-dot"><CheckIcon /></span>
                    {c}
                  </div>
                ))}
              </div>
            </div>

            <div className="ln-slack-approval">
              <div className="ln-slack-sub ln-slack-sub-wait">Waiting for approval</div>
              <div className="ln-slack-approve-row">
                <span className="ln-slack-approve-ic"><MailIcon /></span>
                <span className="ln-slack-approve-tx">{s.approval}</span>
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

export function VerticalLanding({ slug }: { slug: string }) {
  const v: Vertical = VERTICALS[slug];

  return (
    <main id="flm-main">
        {/* HERO — department outcome + a Slack demo for that team */}
        <section className="lp1 ln-hero-section">
          <div className="ln-hero ln-rise ln-rise-1">
            <div className="ln-badge">
              <span className="ln-badge-k">WorkerOS</span>
              <span className="ln-badge-v">{v.eyebrow}</span>
            </div>

            <h1 className="ln-h1">{renderH1(v.h1, v.h1Accent)}</h1>

            <p className="ln-sub">{v.sub}</p>

            <div className="ln-ctas">
              <WaitlistCTA label={v.primaryCtaLabel} source={`${v.slug}-hero`} />
              <a href="#see-how-it-works" className="ln-secondary-btn">
                <PlayIcon />
                See how it works
              </a>
            </div>
          </div>

          <div className="ln-hero-visual ln-rise ln-rise-2">
            <SlackThreadMock v={v} />
          </div>
        </section>

        {/* Tools strip — what this vertical's worker connects to. */}
        <section className="ln-trust lp1">
          <div className="ln-trust-label">{v.toolsLabel}</div>
          <div className="ln-logos">
            {v.tools.map((t) => {
              const Logo = t.logo;
              return (
                <span key={t.label} className="ln-logo-cell">
                  <Logo />
                  {t.label}
                </span>
              );
            })}
          </div>
        </section>

        {/* Outcome grid — the department's jobs, expanded. */}
        <section className="ln-outcome-sec lp1" aria-label="What it ships">
          <div className="ln-sec-head">
            <div className="ln-ft-eye">Outcomes</div>
            <h2>{v.outcomesHead}</h2>
            <p>{v.outcomesSub}</p>
          </div>
          <div className="ln-outcome-grid ln-outcome-grid-detail">
            {v.outcomes.map((o) => (
              <div key={o.title} className="ln-og-card">
                <div className="ln-og-head">
                  <span className="ln-og-dept">{o.title}</span>
                </div>
                <p className="ln-og-body">{o.body}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Capabilities — 4 jobs it does on day one. */}
        <section className="ln-team lp1" aria-label="What it does">
          <div className="ln-sec-head">
            <div className="ln-ft-eye">Capabilities</div>
            <h2>{v.capabilitiesHead}</h2>
            <p>{v.capabilitiesSub}</p>
          </div>

          <div className="lv-caps">
            {v.capabilities.map((c) => {
              const Icon = c.icon;
              return (
                <div key={c.title} className="lv-cap">
                  <span className="lv-cap-ic">
                    <Icon />
                  </span>
                  <h3 className="lv-cap-nm">{c.title}</h3>
                  <p className="lv-cap-body">{c.body}</p>
                  <div className="lv-cap-tools" aria-label="Tools used">
                    {c.tools.map((Tool, i) => (
                      <span key={i} className="lv-cap-tool">
                        <Tool />
                      </span>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Control — the same trust spine as the homepage. */}
        <section className="ln-control-sec lp1" aria-label="Control">
          <div className="ln-sec-head">
            <div className="ln-ft-eye">Control</div>
            <h2>It does the work. You stay in control.</h2>
          </div>
          <div className="ln-control-grid">
            <div className="ln-control-item">
              <span className="ln-control-ic"><ShieldIcon /></span>
              <div className="ln-control-tx">
                <h3>Approvals</h3>
                <p>External actions pause before they ship.</p>
              </div>
            </div>
            <div className="ln-control-item">
              <span className="ln-control-ic"><ClockIcon /></span>
              <div className="ln-control-tx">
                <h3>Replay every run</h3>
                <p>See inputs, steps, tools, cost, and output.</p>
              </div>
            </div>
            <div className="ln-control-item">
              <span className="ln-control-ic"><FolderIcon /></span>
              <div className="ln-control-tx">
                <h3>Context-bound</h3>
                <p>Workers follow your ICP, style guide, playbooks, and rules.</p>
              </div>
            </div>
            <div className="ln-control-item">
              <span className="ln-control-ic"><PlugIcon /></span>
              <div className="ln-control-tx">
                <h3>Tool permissions</h3>
                <p>Each worker only gets the tools it needs.</p>
              </div>
            </div>
          </div>
        </section>

        <section className="ln-cta-section lp1">
          <h2>{v.closingHead}</h2>
          <p className="ln-cta-sub">{v.closingSub}</p>
          <div className="ln-ctas" style={{ marginTop: 34 }}>
            <WaitlistCTA label={v.primaryCtaLabel} source={`${v.slug}-footer`} />
            <a href="#see-how-it-works" className="ln-secondary-btn">
              <PlayIcon />
              See how it works
            </a>
          </div>
        </section>
      </main>
  );
}

/* Render the h1 with the accent word emphasized (matches .ln-h1 em). */
function renderH1(h1: string, accent: string) {
  const idx = h1.toLowerCase().indexOf(accent.toLowerCase());
  if (idx === -1) return h1;
  return (
    <>
      {h1.slice(0, idx)}
      <em>{h1.slice(idx, idx + accent.length)}</em>
      {h1.slice(idx + accent.length)}
    </>
  );
}
