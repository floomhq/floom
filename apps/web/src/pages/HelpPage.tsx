/**
 * HelpPage — /help
 *
 * 3-column card grid: Documentation / Discord / Email
 * + collapsible FAQ section
 * + footer
 *
 * Uses v26 design tokens (var(--ink), var(--card), var(--line), etc.)
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';

const FAQS: { q: string; a: string }[] = [
  {
    q: 'How do I get a Floom agent token?',
    a: 'Sign up at floom.dev/signup, then go to your dashboard (/home). Click "Mint your token" to create one. Copy it once — it won\'t be shown again.',
  },
  {
    q: 'Which AI tools does Floom work with?',
    a: 'Claude Desktop, Cursor, Codex CLI, and any MCP-compatible client. You can also use the HTTP API directly from any tool that can make HTTP requests.',
  },
  {
    q: 'How do I add the MCP server to Claude Desktop?',
    a: 'Open ~/Library/Application Support/Claude/claude_desktop_config.json, paste your MCP config (available on your /home page), then restart Claude Desktop.',
  },
  {
    q: 'I minted a token but lost it. What do I do?',
    a: 'Go to /home and click "Rotate" to revoke the old token and mint a fresh one. Copy the new token immediately — it\'s only shown once.',
  },
  {
    q: 'How do I publish my own app to Floom?',
    a: 'Check the documentation at /docs. You\'ll need a floom.yaml, a public GitHub repo or OpenAPI URL, and an agent token. Then run: floom deploy ./floom.yaml.',
  },
];

function FaqItem({ q, a }: { q: string; a: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div
      style={{
        borderBottom: '1px solid var(--line)',
        paddingBottom: 0,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          padding: '18px 0',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          fontFamily: "'Inter', system-ui, sans-serif",
          textAlign: 'left',
        }}
        aria-expanded={open}
      >
        <span style={{ fontSize: 15, fontWeight: 600, color: 'var(--ink)', lineHeight: 1.4 }}>{q}</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--muted)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0, transition: 'transform 0.15s', transform: open ? 'rotate(180deg)' : 'rotate(0deg)' }}
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>
      {open && (
        <p style={{ fontSize: 14, color: 'var(--muted)', lineHeight: 1.65, margin: '0 0 18px', paddingRight: 28 }}>
          {a}
        </p>
      )}
    </div>
  );
}

function SupportCard({
  href,
  to,
  icon,
  title,
  body,
  badge,
}: {
  href?: string;
  to?: string;
  icon: React.ReactNode;
  title: string;
  body: string;
  badge?: string;
}) {
  const shared: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    padding: '28px 24px',
    border: '1px solid var(--line)',
    borderRadius: 14,
    background: 'var(--card)',
    textDecoration: 'none',
    color: 'var(--ink)',
    transition: 'border-color 0.15s',
  };

  const inner = (
    <>
      <div style={{ marginBottom: 16 }}>{icon}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--ink)', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
        {title}
        {badge && (
          <span style={{
            fontSize: 10.5,
            fontWeight: 700,
            background: 'var(--accent)',
            color: '#fff',
            padding: '2px 7px',
            borderRadius: 999,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
          }}>
            {badge}
          </span>
        )}
      </div>
      <p style={{ fontSize: 13.5, color: 'var(--muted)', lineHeight: 1.6, margin: 0 }}>{body}</p>
    </>
  );

  if (href) {
    return (
      <a
        href={href}
        target={href.startsWith('http') ? '_blank' : undefined}
        rel={href.startsWith('http') ? 'noreferrer' : undefined}
        style={shared}
        onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--accent)'; }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--line)'; }}
      >
        {inner}
      </a>
    );
  }
  return (
    <Link
      to={to!}
      style={shared}
      onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--accent)'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.borderColor = 'var(--line)'; }}
    >
      {inner}
    </Link>
  );
}

// Simple SVG icons
function IconBook() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}

function IconDiscord() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="var(--accent)" aria-hidden="true">
      <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057c.001.022.015.043.033.055a19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
    </svg>
  );
}

function IconMail() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
      <polyline points="22,6 12,13 2,6" />
    </svg>
  );
}

export function HelpPage() {
  return (
    <PageShell title="Help & Support · Floom">
      <div
        style={{
          fontFamily: "'Inter', system-ui, sans-serif",
        }}
      >
        {/* Hero */}
        <div
          style={{
            background: 'linear-gradient(180deg, var(--card) 0%, var(--bg) 100%)',
            borderBottom: '1px solid var(--line)',
            padding: '64px 24px 56px',
            textAlign: 'center',
          }}
        >
          <h1
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 800,
              fontSize: 40,
              letterSpacing: '-0.025em',
              color: 'var(--ink)',
              margin: '0 0 14px',
            }}
          >
            Help & Support
          </h1>
          <p style={{ fontSize: 16, color: 'var(--muted)', margin: 0, lineHeight: 1.6, maxWidth: 480, marginLeft: 'auto', marginRight: 'auto' }}>
            Docs, community, and a real human. Pick the fastest path.
          </p>
        </div>

        {/* 3-column card grid */}
        <div style={{ maxWidth: 960, margin: '0 auto', padding: '56px 24px 0' }}>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
              gap: 16,
            }}
          >
            <SupportCard
              to="/docs"
              icon={<IconBook />}
              title="Documentation"
              body="MCP protocol reference, CLI guide, HTTP API, and how to publish your first app."
            />
            <SupportCard
              href="https://discord.gg/floom"
              icon={<IconDiscord />}
              title="Discord community"
              body="Ask questions, share apps, and get real-time help from the team and other builders."
              badge="Fast"
            />
            <SupportCard
              href="mailto:hello@floom.dev"
              icon={<IconMail />}
              title="Email us"
              body="hello@floom.dev — we reply within 24 hours. Good for account issues or billing questions."
            />
          </div>

          {/* FAQ */}
          <div style={{ marginTop: 64 }}>
            <h2
              style={{
                fontFamily: 'var(--font-display)',
                fontWeight: 800,
                fontSize: 26,
                letterSpacing: '-0.02em',
                color: 'var(--ink)',
                margin: '0 0 8px',
              }}
            >
              Common questions
            </h2>
            <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 32px' }}>
              Can't find an answer?{' '}
              <a href="https://discord.gg/floom" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}>
                Ask in Discord
              </a>
              .
            </p>
            <div style={{ borderTop: '1px solid var(--line)' }}>
              {FAQS.map((faq) => (
                <FaqItem key={faq.q} q={faq.q} a={faq.a} />
              ))}
            </div>
          </div>

          {/* Footer spacer */}
          <div style={{ height: 80 }} />
        </div>
      </div>
    </PageShell>
  );
}
