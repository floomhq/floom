/**
 * LandingMVPPage — slim landing for the launch-mvp branch.
 *
 * Fix 2 (restore context) + Fix 3 (one subtitle).
 *
 * Structure:
 *   Header (anon: logo · Apps · Docs · Help · Sign in · Sign up)
 *   Hero (H1 + ONE subline + CTA)
 *   What Floom does (2-3 short paragraphs)
 *   3-step explainer
 *   Mini apps section
 *   Footer (floom · Apps · Docs · Help · Privacy · Terms)
 *
 * NO GitHub badge in primary nav, NO Pricing in anon nav, NO "Built in SF".
 */

import { Link } from 'react-router-dom';
import { useEffect, useState } from 'react';
import * as api from '../api/client';
import type { HubApp } from '../lib/types';

// ---------- styles ----------

const INK = '#0e0e0c';
const MUTED = '#585550';
const ACCENT = '#047857';
const BG = '#fafaf8';
const CARD = '#fff';
const LINE = 'rgba(14,14,12,0.1)';

export function LandingMVPPage() {
  const [featuredApps, setFeaturedApps] = useState<HubApp[]>([]);

  useEffect(() => {
    api.getHub()
      .then(apps => {
        const featured = apps.filter(a => a.featured).slice(0, 4);
        // Fall back to top 4 by position if no featured flags set yet
        setFeaturedApps(featured.length > 0 ? featured : apps.slice(0, 4));
      })
      .catch(() => { /* silently skip the section */ });
  }, []);

  return (
    <div
      data-testid="landing-mvp"
      style={{
        minHeight: '100vh',
        background: BG,
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'Inter', system-ui, sans-serif",
        color: INK,
      }}
    >
      {/* ─── Slim anon header ─── */}
      <header
        style={{
          height: 52,
          borderBottom: `1px solid ${LINE}`,
          background: CARD,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '0 24px',
          position: 'sticky',
          top: 0,
          zIndex: 100,
        }}
      >
        {/* Logo */}
        <Link
          to="/"
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 600,
            fontSize: 17,
            color: INK,
            textDecoration: 'none',
            letterSpacing: '-0.02em',
          }}
        >
          floom
        </Link>

        {/* Centre nav: Apps · Docs · Help */}
        <nav
          aria-label="Primary"
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: 'translate(-50%, -50%)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 2,
          }}
          className="landing-centre-nav"
        >
          <Link to="/apps" style={{ fontSize: 13, fontWeight: 500, color: MUTED, textDecoration: 'none', padding: '7px 10px', borderRadius: 6 }}>Apps</Link>
          <Link to="/docs" style={{ fontSize: 13, fontWeight: 500, color: MUTED, textDecoration: 'none', padding: '7px 10px', borderRadius: 6 }}>Docs</Link>
          <Link to="/help" style={{ fontSize: 13, fontWeight: 500, color: MUTED, textDecoration: 'none', padding: '7px 10px', borderRadius: 6 }}>Help</Link>
        </nav>

        {/* Right: Sign in + Sign up */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Link
            to="/login"
            style={{
              fontSize: 13,
              fontWeight: 500,
              color: INK,
              textDecoration: 'none',
              padding: '7px 14px',
              borderRadius: 6,
              border: `1px solid ${LINE}`,
              background: BG,
            }}
          >
            Sign in
          </Link>
          <Link
            to="/signup"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '7px 14px',
              borderRadius: 6,
              background: INK,
              color: '#fff',
              fontSize: 13,
              fontWeight: 600,
              textDecoration: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            Sign up
          </Link>
        </div>
      </header>

      {/* ─── Main content ─── */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>

        {/* Hero */}
        <section
          data-testid="mvp-hero"
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            textAlign: 'center',
            padding: '80px 24px 64px',
            borderBottom: `1px solid ${LINE}`,
            background: `linear-gradient(180deg, ${CARD} 0%, ${BG} 100%)`,
          }}
        >
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 800,
              fontSize: 'clamp(36px, 6vw, 58px)',
              lineHeight: 1.03,
              letterSpacing: '-0.025em',
              color: INK,
              margin: '0 0 16px',
              maxWidth: 720,
            }}
          >
            Ship AI apps fast.
          </h1>
          {/* ONE subtitle only — Fix 3 */}
          <p
            style={{
              fontSize: 18,
              lineHeight: 1.5,
              color: MUTED,
              maxWidth: 480,
              margin: '0 auto 36px',
              fontWeight: 400,
            }}
          >
            The protocol and runtime for agentic work.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
            <Link
              to="/signup"
              data-testid="mvp-hero-cta"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '14px 28px',
                borderRadius: 999,
                background: INK,
                color: '#fff',
                fontSize: 16,
                fontWeight: 700,
                textDecoration: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              Get your MCP token →
            </Link>
            <Link
              to="/login"
              style={{ fontSize: 13, color: MUTED, textDecoration: 'none' }}
            >
              Already have an account? Sign in
            </Link>
          </div>
        </section>

        {/* What Floom does */}
        <section
          data-testid="mvp-what"
          style={{
            maxWidth: 760,
            margin: '0 auto',
            padding: '56px 24px 0',
            width: '100%',
          }}
        >
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 800,
              fontSize: 22,
              letterSpacing: '-0.02em',
              color: INK,
              margin: '0 0 20px',
            }}
          >
            What is Floom?
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 24,
            }}
          >
            <div>
              <p style={{ fontSize: 14, color: INK, fontWeight: 600, margin: '0 0 6px' }}>A workspace + runtime</p>
              <p style={{ fontSize: 14, color: MUTED, lineHeight: 1.65, margin: 0 }}>
                Floom gives every AI app a canonical HTTP endpoint, an MCP server, and a CLI — so it runs anywhere your agent does.
              </p>
            </div>
            <div>
              <p style={{ fontSize: 14, color: INK, fontWeight: 600, margin: '0 0 6px' }}>For non-dev AI engineers</p>
              <p style={{ fontSize: 14, color: MUTED, lineHeight: 1.65, margin: 0 }}>
                You don't need a DevOps background. Paste a GitHub link and you get a runnable, shareable, rate-limited app in under 30 seconds.
              </p>
            </div>
            <div>
              <p style={{ fontSize: 14, color: INK, fontWeight: 600, margin: '0 0 6px' }}>Vibe-code speed, production safety</p>
              <p style={{ fontSize: 14, color: MUTED, lineHeight: 1.65, margin: 0 }}>
                Secrets stay encrypted. Runs are logged and auditable. Apps are shareable or private. Ship fast without sacrificing guardrails.
              </p>
            </div>
          </div>
        </section>

        {/* 3-step explainer */}
        <section
          data-testid="mvp-steps"
          style={{ padding: '56px 24px 64px', maxWidth: 800, margin: '0 auto', width: '100%' }}
        >
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 800,
              fontSize: 22,
              letterSpacing: '-0.02em',
              textAlign: 'center',
              margin: '0 0 36px',
              color: INK,
            }}
          >
            Up and running in 3 steps
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
            {STEPS.map((step) => (
              <div
                key={step.num}
                style={{
                  background: CARD,
                  border: `1px solid ${LINE}`,
                  borderRadius: 12,
                  padding: '20px 18px',
                }}
              >
                <div
                  style={{
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 10,
                    fontWeight: 700,
                    letterSpacing: '0.08em',
                    color: ACCENT,
                    textTransform: 'uppercase' as const,
                    marginBottom: 10,
                  }}
                >
                  Step {step.num}
                </div>
                <h3
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    margin: '0 0 8px',
                    color: INK,
                    lineHeight: 1.3,
                  }}
                >
                  {step.title}
                </h3>
                <p style={{ fontSize: 13, color: MUTED, lineHeight: 1.55, margin: 0 }}>
                  {step.body}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Featured apps mini-section */}
        <section
          data-testid="mvp-apps"
          style={{
            borderTop: `1px solid ${LINE}`,
            padding: '56px 24px 64px',
            background: CARD,
          }}
        >
          <div style={{ maxWidth: 800, margin: '0 auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28, flexWrap: 'wrap', gap: 12 }}>
              <h2
                style={{
                  fontFamily: 'var(--font-display)',
                  fontWeight: 800,
                  fontSize: 22,
                  letterSpacing: '-0.02em',
                  color: INK,
                  margin: 0,
                }}
              >
                Browse apps
              </h2>
              <Link
                to="/apps"
                style={{ fontSize: 13, color: ACCENT, textDecoration: 'none', fontWeight: 600 }}
              >
                View all →
              </Link>
            </div>
            {featuredApps.length > 0 && (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 14 }}>
                {featuredApps.map(app => (
                  <Link
                    key={app.slug}
                    to={`/p/${app.slug}`}
                    style={{ display: 'block', padding: '16px 18px', background: BG, border: `1px solid ${LINE}`, borderRadius: 10, textDecoration: 'none' }}
                  >
                    {app.icon && <div style={{ fontSize: 24, marginBottom: 8 }}>{app.icon}</div>}
                    <div style={{ fontSize: 14, fontWeight: 600, color: INK, marginBottom: 4 }}>{app.name}</div>
                    <div style={{ fontSize: 12, color: MUTED, lineHeight: 1.5 }}>{app.description}</div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </section>

      </main>

      {/* ─── Mini footer ─── */}
      <footer
        data-testid="mvp-footer"
        style={{
          borderTop: `1px solid ${LINE}`,
          padding: '16px 24px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12,
          background: CARD,
        }}
      >
        <Link
          to="/"
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 14,
            color: INK,
            textDecoration: 'none',
            letterSpacing: '-0.02em',
          }}
        >
          floom
        </Link>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <Link to="/apps" style={{ fontSize: 12.5, color: MUTED, textDecoration: 'none' }}>Apps</Link>
          <Link to="/docs" style={{ fontSize: 12.5, color: MUTED, textDecoration: 'none' }}>Docs</Link>
          <Link to="/help" style={{ fontSize: 12.5, color: MUTED, textDecoration: 'none' }}>Help</Link>
          <Link to="/privacy" style={{ fontSize: 12.5, color: MUTED, textDecoration: 'none' }}>Privacy</Link>
          <Link to="/terms" style={{ fontSize: 12.5, color: MUTED, textDecoration: 'none' }}>Terms</Link>
        </div>
      </footer>
    </div>
  );
}

const STEPS = [
  {
    num: '1',
    title: 'Sign up',
    body: 'Create a free account. No credit card. Free during the beta.',
  },
  {
    num: '2',
    title: 'Mint your token',
    body: 'One click to generate your floom_agent_* workspace credential.',
  },
  {
    num: '3',
    title: 'Paste the config',
    body: 'Drop the MCP config into Claude Desktop, Cursor, Codex, or any MCP client.',
  },
];

