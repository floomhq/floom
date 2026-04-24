// 2026-04-20 (PRR tail cleanup): /install is a public landing stub for the
// Floom CLI install steps. 2026-04-24 rewrite: lead with the Docker
// one-liner (the self-host path that actually works today) rather than
// the pnpm dev-clone. CLI is still on the roadmap; dev-clone stays
// behind a collapsed details block for contributors. Docker image +
// port match what prod compose uses: ghcr.io/floomhq/floom-monorepo,
// port 3000.

import { useState } from 'react';
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
  const [devOpen, setDevOpen] = useState(false);
  return (
    <PageShell
      title="Self-host Floom · Floom"
      description="Run Floom on your own server in one Docker command. Open source, no waitlist."
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
          Self-host Floom
        </h1>
        <p style={{ color: 'var(--muted)', fontSize: 16, margin: '0 0 28px' }}>
          Run Floom on your own server in one command. Open source, no waitlist,
          no signup.
        </p>

        <h2 style={{ fontSize: 18, margin: '24px 0 8px' }}>1. Docker (recommended)</h2>
        <pre style={codeBlockStyle}>
          docker run -p 3000:3000 ghcr.io/floomhq/floom-monorepo:latest
        </pre>
        <p style={{ color: 'var(--muted)', margin: '0 0 20px', fontSize: 14 }}>
          Visit <code>http://localhost:3000</code>. Self-hosted Floom ships with
          publish enabled by default, so you can paste an OpenAPI spec and get a
          live app without joining any waitlist.
        </p>

        <h2 style={{ fontSize: 18, margin: '24px 0 8px' }}>2. CLI (coming soon)</h2>
        <p style={{ color: 'var(--muted)', margin: '0 0 6px', fontSize: 14 }}>
          A published npm CLI (<code>@floomhq/cli</code>) is on the roadmap.
          Until then, the Docker image is the self-host path.
        </p>
        <pre style={codeBlockStyle}>
          # coming soon{'\n'}
          npm i -g @floomhq/cli
        </pre>

        <h2 style={{ fontSize: 18, margin: '24px 0 8px' }}>3. Link it to Claude</h2>
        <p style={{ color: 'var(--muted)', margin: '0 0 6px', fontSize: 14 }}>
          The MCP endpoint is at <code>http://localhost:3000/mcp</code>. Add it
          in Claude Desktop settings and every app on your instance becomes a
          Claude tool.
        </p>

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

        {/* Dev install / contribute — collapsed by default. For users
            who want to hack on the monorepo rather than run the prebuilt
            image. Kept here so the old pnpm dev-clone workflow is still
            discoverable. */}
        <details
          data-testid="install-dev"
          open={devOpen}
          onToggle={(e) => setDevOpen((e.target as HTMLDetailsElement).open)}
          style={{
            margin: '32px 0 0',
            padding: '14px 18px',
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 10,
          }}
        >
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--ink)',
            }}
          >
            Dev install / contribute
          </summary>
          <p style={{ color: 'var(--muted)', margin: '10px 0 6px', fontSize: 14 }}>
            Clone the monorepo and run the server from source. Needed if you
            want to hack on Floom itself.
          </p>
          <pre style={codeBlockStyle}>
            git clone https://github.com/floomhq/floom.git{'\n'}
            cd floom{'\n'}
            pnpm install{'\n'}
            pnpm --filter @floom/server dev
          </pre>
          <p style={{ color: 'var(--muted)', margin: '0 0 0', fontSize: 14 }}>
            The server comes up on <code>http://localhost:8787</code> with the
            dashboard served from the same host.
          </p>
        </details>
      </main>
    </PageShell>
  );
}
