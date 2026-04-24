// 2026-04-20 (PRR tail cleanup): /install is a public landing stub for the
// Floom CLI install steps. The wireframes + sitemap link here from the
// top-bar "Install" affordance, so the route needed to exist (returned 404
// before). Keeps the copy short, points at self-host docs + the GitHub
// repo for the authoritative source. When a real CLI ships, the steps
// below get upgraded in-place without changing the URL surface.

import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';

// Code blocks use the brand warm-dark neutral so the install commands
// are legible on both light and dark themes. Earlier iterations used
// `#0d0f14` (near-black) — Federico's LOCKED rule bans pure black on
// hero/landing terminal panels and code blocks (MEMORY "Terminal
// Background Never Black", feedback_terminal_never_black.md). Use the
// same `#1b1a17` token as the landing hero code panel + the
// InstallInClaudePage snippets so every terminal surface on the site
// reads as one consistent warm-dark palette.
const codeBlockStyle: React.CSSProperties = {
  background: '#1b1a17',
  color: '#e8e6e0',
  padding: '14px 16px',
  borderRadius: 10,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 13,
  lineHeight: 1.5,
  overflowX: 'auto',
  border: '1px solid rgba(255,255,255,0.08)',
  margin: '8px 0 20px',
};

export function InstallPage() {
  return (
    <PageShell
      title="Install the Floom CLI · Floom"
      description="Install the Floom command-line in one line. Publish apps, tail runs, and manage your Floom deployments from your terminal."
    >
      <main
        data-testid="install-page"
        style={{ maxWidth: 720, margin: '40px auto', padding: '0 24px' }}
      >
        <h1
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 34,
            fontWeight: 700,
            letterSpacing: '-0.025em',
            lineHeight: 1.1,
            margin: '0 0 12px',
            color: 'var(--ink)',
          }}
        >
          Install the Floom CLI
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 16, margin: '0 0 28px' }}>
          Run Floom locally against your own stack, publish apps from the
          terminal, and hook Floom into CI.
        </p>

        <h2 style={{ fontSize: 18, margin: '24px 0 8px' }}>1. Clone the repo</h2>
        <p style={{ color: 'var(--muted)', margin: '0 0 6px', fontSize: 14 }}>
          Today Floom ships as a git-installable workspace. A published npm
          CLI is on the roadmap; until then, clone the repo and run the
          server from the checkout.
        </p>
        <pre style={codeBlockStyle}>
          git clone https://github.com/floomhq/floom.git{'\n'}
          cd floom{'\n'}
          pnpm install
        </pre>

        <h2 style={{ fontSize: 18, margin: '24px 0 8px' }}>2. Boot the server</h2>
        <pre style={codeBlockStyle}>
          pnpm --filter @floom/server dev
        </pre>
        <p style={{ color: 'var(--muted)', margin: '0 0 20px', fontSize: 14 }}>
          The server comes up on <code>http://localhost:8787</code> with the
          dashboard served from the same host.
        </p>

        <h2 style={{ fontSize: 18, margin: '24px 0 8px' }}>3. Publish an app</h2>
        <p style={{ color: 'var(--muted)', margin: '0 0 6px', fontSize: 14 }}>
          Point an OpenAPI spec at <code>POST /api/publish</code> and Floom
          wraps it into a runnable app with a shareable permalink.
        </p>
        <pre style={codeBlockStyle}>
          curl -X POST http://localhost:8787/api/publish \{'\n'}
          {'  '}-H "content-type: application/json" \{'\n'}
          {'  '}-d '{'{'}"openapi_spec_url": "https://.../openapi.json"{'}'}'
        </pre>

        <h2 style={{ fontSize: 18, margin: '24px 0 8px' }}>Full docs</h2>
        <ul style={{ color: 'var(--muted)', lineHeight: 1.8, paddingLeft: 20 }}>
          <li>
            <Link to="/protocol" style={{ color: 'var(--accent)' }}>
              The Floom protocol
            </Link>{' '}
            — endpoints, auth, app shapes
          </li>
          <li>
            <Link to="/protocol#self-hosting" style={{ color: 'var(--accent)' }}>
              Self-hosting
            </Link>{' '}
            — Docker compose + environment
          </li>
          <li>
            <a
              href="https://github.com/floomhq/floom"
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent)' }}
            >
              GitHub repo
            </a>{' '}
            — source, examples, issues
          </li>
        </ul>
      </main>
    </PageShell>
  );
}
