// v17 Docs hub landing page.
//
// Replaces the /docs → /protocol redirect with a real landing page
// anchored on the wireframe at /var/www/wireframes-floom/v17/docs.html.
// Two-column shell: DocsSidebar (grouped nav, shared with /docs/:slug
// detail pages) + welcome content (quick-start + most-read + MCP install
// trio + self-host snippet + runtime specs table + Discord CTA).
//
// The welcome content is intentionally not markdown — it's the one docs
// page with its own layout blocks (surface-card grid, spec table,
// footer CTA) that don't map cleanly to react-markdown.

import { Link, useLocation } from 'react-router-dom';
import type { CSSProperties } from 'react';
import { useMemo } from 'react';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { FeedbackButton } from '../components/FeedbackButton';
import { PageHead } from '../components/PageHead';
import { DocsSidebar, DOCS_SIDEBAR_GROUPS } from '../components/docs/DocsSidebar';
import { DocsPublishWaitlistBanner } from '../components/docs/DocsPublishWaitlistBanner';
import { DocsHeroCards } from '../components/docs/DocsHeroCards';
import { readDeployEnabled } from '../lib/flags';

// ── Styles ────────────────────────────────────────────────────────────────

const shellStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '260px minmax(0, 1fr)',
  gap: 0,
  maxWidth: 1260,
  margin: '0 auto',
  minHeight: 720,
};

const mainStyle: CSSProperties = {
  // Audit 2026-04-24 (S2): /docs was dense above the fold. Dropped top padding
  // 44 → 28 and bottom 60 → 48 so the H1 + lede + first code block can all
  // breathe in the first viewport without squeezing the sidebar.
  padding: '28px 48px 48px',
  minWidth: 0,
};

const crumbsStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12,
  color: 'var(--muted)',
  marginBottom: 12,
  letterSpacing: '0.02em',
};

const h1Style: CSSProperties = {
  // Audit 2026-04-24 (S3, docs-sexier pass): bumped 40 → 52 so the H1 is a
  // real display hero, matching the weight of Stripe/Vercel/Linear docs
  // landing pages. Tighter letter-spacing + lead-balance for cleaner wrap.
  fontFamily: 'var(--font-display)',
  fontWeight: 800,
  fontSize: 52,
  lineHeight: 1.05,
  letterSpacing: '-0.025em',
  margin: '0 0 14px',
  maxWidth: 720,
  textWrap: 'balance' as CSSProperties['textWrap'],
};

const ledeStyle: CSSProperties = {
  fontSize: 18,
  color: 'var(--muted)',
  // Audit 2026-04-24: tightened 36 → 22 so the install command lands closer to
  // the hero copy and the "try this" moment is in-view on first paint.
  margin: '0 0 22px',
  maxWidth: 640,
  lineHeight: 1.5,
};

const h2Style: CSSProperties = {
  fontSize: 22,
  fontWeight: 600,
  letterSpacing: '-0.01em',
  // Audit 2026-04-24: top margin 36 → 28 to tighten section rhythm.
  margin: '28px 0 14px',
  paddingBottom: 10,
  borderBottom: '1px solid var(--line)',
  scrollMarginTop: 24,
};

const h3Style: CSSProperties = {
  fontSize: 16,
  fontWeight: 600,
  margin: '22px 0 10px',
};

const pStyle: CSSProperties = {
  fontSize: 15,
  color: 'var(--ink)',
  lineHeight: 1.7,
  margin: '0 0 14px',
  maxWidth: 640,
};

const codeBlockStyle: CSSProperties = {
  background: 'var(--card)',
  color: 'var(--ink)',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 14,
  lineHeight: 1.7,
  padding: '18px 20px',
  borderRadius: 10,
  margin: '16px 0 24px',
  maxWidth: 640,
  overflowX: 'auto',
  border: '1px solid var(--line)',
  whiteSpace: 'pre',
};

// Hero terminal: warm dark neutral (#1b1a17) NOT pure black. Matches the
// brand's terminal look on landing. Only used for the canonical "install
// in 60 seconds" snippet right under the H1, to give the docs landing
// the same polished hero moment you get from Stripe / Vercel docs.
const heroCodeBlockStyle: CSSProperties = {
  background: '#1b1a17',
  color: '#f5f4ef',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 14,
  lineHeight: 1.75,
  padding: '18px 20px',
  borderRadius: 12,
  margin: '0 0 18px',
  maxWidth: 760,
  overflowX: 'auto',
  border: '1px solid #2a2824',
  whiteSpace: 'pre',
  boxShadow: '0 12px 28px -18px rgba(0, 0, 0, 0.35)',
};

const heroCodeCommentStyle: CSSProperties = {
  color: '#8a877f',
};

const heroCodePromptStyle: CSSProperties = {
  color: '#6fcf97',
  userSelect: 'none',
};

const quickStartStyle: CSSProperties = {
  // Audit 2026-04-24: trimmed 4 pills → 2 and moved the row below the install
  // code block, so this is now a "next steps" row rather than a top-of-page
  // nav. Bottom margin trimmed 28 → 8 (the next H2 supplies its own top margin).
  display: 'flex',
  gap: 10,
  flexWrap: 'wrap',
  marginBottom: 8,
};

const pillStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 8,
  /* Reached 44px height (issue #588) */
  padding: '15px 14px',
  borderRadius: 10,
  background: 'var(--card)',
  border: '1px solid var(--line)',
  fontSize: 14,
  fontWeight: 500,
  textDecoration: 'none',
  color: 'var(--ink)',
};

const pillKeyStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12,
  color: 'var(--muted)',
  fontWeight: 400,
};

const mostReadStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, 1fr)',
  gap: 12,
  margin: '24px 0 36px',
  maxWidth: 640,
};

const mrCardStyle: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  /* Bumped hit target to 44px+ (issue #588) */
  padding: '16px 16px',
  textDecoration: 'none',
  color: 'inherit',
  display: 'block',
};

const mrKicker: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12,
  color: 'var(--muted)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  marginBottom: 4,
};

const mrTitle: CSSProperties = {
  fontSize: 14,
  fontWeight: 600,
  marginBottom: 3,
  lineHeight: 1.3,
};

const mrSubtitle: CSSProperties = {
  fontSize: 14,
  color: 'var(--muted)',
  lineHeight: 1.45,
};

const surfaceGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, 1fr)',
  gap: 12,
  margin: '20px 0 28px',
  maxWidth: 640,
};

const surfaceCardStyle: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 12,
  padding: '16px 16px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const surfaceNameStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 12,
  color: 'var(--accent)',
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  fontWeight: 700,
};

const surfaceTitleStyle: CSSProperties = {
  fontSize: 14.5,
  fontWeight: 600,
  color: 'var(--ink)',
  lineHeight: 1.3,
};

const surfaceToolStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  color: 'var(--ink)',
  background: 'var(--studio, var(--bg))',
  border: '1px solid var(--line)',
  borderRadius: 5,
  padding: '2px 7px',
  alignSelf: 'flex-start',
  marginTop: 4,
};

const specTableStyle: CSSProperties = {
  width: '100%',
  maxWidth: 640,
  borderCollapse: 'collapse',
  margin: '14px 0 24px',
  fontSize: 14,
  border: '1px solid var(--line)',
  borderRadius: 10,
  overflow: 'hidden',
};

const specThStyle: CSSProperties = {
  fontWeight: 600,
  color: 'var(--ink)',
  background: 'var(--bg)',
  fontSize: 14,
  letterSpacing: '0.02em',
  padding: '10px 14px',
  textAlign: 'left',
  borderBottom: '1px solid var(--line)',
};

const specTdStyle: CSSProperties = {
  padding: '10px 14px',
  textAlign: 'left',
  borderBottom: '1px solid var(--line)',
  verticalAlign: 'top',
};

const specTdMonoStyle: CSSProperties = {
  ...specTdStyle,
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 14,
  color: 'var(--accent)',
  fontWeight: 600,
  whiteSpace: 'nowrap',
};

const specTdNoteStyle: CSSProperties = {
  ...specTdStyle,
  color: 'var(--muted)',
  fontSize: 14,
};

const discordFootStyle: CSSProperties = {
  marginTop: 48,
  padding: 24,
  background: 'linear-gradient(180deg, var(--card), var(--accent-soft))',
  border: '1px solid var(--accent-border, var(--line))',
  borderRadius: 14,
  display: 'flex',
  alignItems: 'center',
  gap: 16,
  maxWidth: 640,
  flexWrap: 'wrap',
};

// ── Page ──────────────────────────────────────────────────────────────────

export function DocsLandingPage() {
  const { pathname } = useLocation();
  const deployEnabled = useMemo(() => readDeployEnabled(), []);

  return (
    <div className="page-root" data-testid="docs-landing-page">
      <PageHead
        title="Docs · Floom"
        description="Everything you need to ship an AI app on Floom: quickstart, protocol, operations, billing, and self-hosting."
      />
      <TopBar />
      <DocsPublishWaitlistBanner />

      <main className="docs-shell" style={shellStyle}>
        <style>{`
          @media (max-width: 900px) {
            .docs-shell { grid-template-columns: 1fr !important; }
            .docs-shell > article { padding: 20px 18px 48px !important; }
          }
        `}</style>
        <DocsSidebar groups={DOCS_SIDEBAR_GROUPS} currentPath={pathname} />

        <article style={mainStyle}>
          <nav style={crumbsStyle} aria-label="Breadcrumb">
            <Link to="/docs" style={{ color: 'var(--muted)', textDecoration: 'none' }}>
              Docs
            </Link>
            {' / Welcome'}
          </nav>

          {/* Docs-sexier pass (2026-04-24): replaced the literal "Floom docs."
              title with a real display H1 + a positioning lede. Same voice as
              Floom's landing ("Ship AI apps fast."), just tuned for a docs
              audience that wants to know what they'll learn here. Then a
              3-card "where to start" row (Deploy / Protocol / Self-host) and
              a warm-dark hero terminal showing the canonical one-liner — so
              the first viewport on /docs has an H1, a promise, the three
              highest-signal entry points, AND something you can copy-paste,
              not just a wall of nav. */}
          <h1 style={h1Style}>Everything you need to ship.</h1>
          <p style={ledeStyle}>
            {deployEnabled ? (
              <>
                The protocol, the runtime, and the patterns that make Floom work.
                Write a manifest, ship an app, let users (or agents) run it.
              </>
            ) : (
              <>
                The protocol, the runtime, and the patterns that make Floom work.
                Run apps today via MCP, CLI, or web. Ship to the floom.dev cloud
                when publishing opens for your account — or self-host, no waitlist.
              </>
            )}
          </p>

          <DocsHeroCards />

          <pre style={heroCodeBlockStyle}>
            <span style={heroCodeCommentStyle}>{'# macOS / Linux — one command, no Node required\n'}</span>
            <span style={heroCodePromptStyle}>{'$ '}</span>
            {'curl -fsSL https://floom.dev/install.sh | bash\n\n'}
            <span style={heroCodeCommentStyle}>{'# verify\n'}</span>
            <span style={heroCodePromptStyle}>{'$ '}</span>
            {'floom --version'}
          </pre>

          <div style={quickStartStyle}>
            <Link to="/docs/quickstart" style={pillStyle}>
              5-min quickstart
              <span style={pillKeyStyle}>→</span>
            </Link>
            <Link to="/docs/mcp-install" style={pillStyle}>
              Install in Claude / Cursor
            </Link>
          </div>

          {/* Run your first app */}
          <h2 style={h2Style}>Run your first app</h2>
          <p style={pStyle}>
            Every Floom app is a manifest plus code. You can run one from the store
            without installing anything: paste a JSON input, get JSON back.
          </p>
          <pre style={codeBlockStyle}>{`# run lead-scorer from the store
floom run lead-scorer --input '{"company":"stripe.com"}'

# or via HTTP
curl -X POST https://api.floom.dev/api/lead-scorer/run \\
  -H "Authorization: Bearer $FLOOM_KEY" \\
  -d '{"action":"score","inputs":{"icp":"B2B SaaS","data":{...}}}'`}</pre>

          {/* Most read */}
          <h2 style={h2Style}>Most read</h2>
          <div style={mostReadStyle}>
            <Link to="/docs/mcp-install" style={mrCardStyle}>
              <div style={mrKicker}>Getting started</div>
              <div style={mrTitle}>Install in Claude / Cursor</div>
              <div style={mrSubtitle}>Three JSON snippets, one per MCP client.</div>
            </Link>
            <Link to="/docs/runtime-specs" style={mrCardStyle}>
              <div style={mrKicker}>Protocol</div>
              <div style={mrTitle}>Manifest reference</div>
              <div style={mrSubtitle}>
                Every field explained. Inputs, outputs, auth, limits.
              </div>
            </Link>
            <Link to="/docs/self-host" style={mrCardStyle}>
              <div style={mrKicker}>Deploy</div>
              <div style={mrTitle}>Self-host with Docker</div>
              <div style={mrSubtitle}>
                Compose quickstart, env var reference, rollback.
              </div>
            </Link>
            <Link to="/docs/limits" style={mrCardStyle}>
              <div style={mrKicker}>Limits</div>
              <div style={mrTitle}>Runtime and rate limits</div>
              <div style={mrSubtitle}>
                5 / 150 / 300 / 500. Timeouts and memory caps.
              </div>
            </Link>
          </div>

          {/* What Floom is */}
          <h2 style={h2Style}>What Floom is (and what it isn't)</h2>
          <p style={pStyle}>
            Floom is for internal tools, productivity apps, and weekend-project apps
            that do real work: score leads, screen resumes, analyse competitors,
            classify webhooks. Think 3 to 50 steps per run, JSON in, bearer or API-key
            auth, done in seconds to a few minutes.
          </p>
          <p style={pStyle}>
            It is not a workflow builder like n8n, it is not a frontend generator
            like Lovable, it is not a model playground like Hugging Face Spaces. It
            is the thin, opinionated layer between your app idea and a running
            endpoint.
          </p>

          {/* MCP install */}
          <h2 id="mcp-surfaces" style={h2Style}>
            Install in Claude, Cursor, Codex — via MCP
          </h2>
          <p style={pStyle}>
            Every Floom app is a ready-to-use MCP tool at{' '}
            <code>mcp.floom.dev/app/&lt;slug&gt;</code>. Point your agent at that URL
            and it can call the app like any other tool. There&apos;s also a discovery
            endpoint so agents can find apps on their own, and a web Studio for
            managing the apps you own
            {deployEnabled ? '.' : ' (new publishes to floom.dev are waitlist-only).'}
          </p>

          <div style={surfaceGridStyle}>
            <div style={surfaceCardStyle}>
              <span style={surfaceNameStyle}>Discover</span>
              <div style={surfaceTitleStyle}>Find apps</div>
              <p style={{ ...pStyle, fontSize: 14, margin: 0 }}>
                JSON list of live apps with manifests. Read-only, no auth.
              </p>
              <span style={surfaceToolStyle}>mcp.floom.dev/search</span>
            </div>
            <div style={surfaceCardStyle}>
              <span style={surfaceNameStyle}>Run</span>
              <div style={surfaceTitleStyle}>Run an app</div>
              <p style={{ ...pStyle, fontSize: 14, margin: 0 }}>
                One MCP endpoint per app. Invoke with JSON, get structured JSON back.
              </p>
              <span style={surfaceToolStyle}>
                mcp.floom.dev/app/&lt;slug&gt;
              </span>
            </div>
            <div style={surfaceCardStyle}>
              <span style={surfaceNameStyle}>Manage</span>
              <div style={surfaceTitleStyle}>Your apps</div>
              <p style={{ ...pStyle, fontSize: 14, margin: 0 }}>
                {deployEnabled ? (
                  <>Create, update, rotate secrets. Web UI, not an MCP endpoint.</>
                ) : (
                  <>
                    Create, update, rotate secrets when your account can publish on
                    floom.dev (waitlist during launch). Self-host has no such gate.
                    Web UI, not an MCP endpoint.
                  </>
                )}
              </p>
              <span style={surfaceToolStyle}>floom.dev/studio</span>
            </div>
          </div>

          <p style={pStyle}>
            Full per-client config (Claude Desktop, Claude Code, Cursor, Codex CLI)
            lives at{' '}
            <Link to="/docs/mcp-install" style={{ color: 'var(--accent)' }}>
              MCP install
            </Link>
            .
          </p>

          {/* Self-host snippet */}
          <h2 id="self-host" style={h2Style}>
            Self-host Floom
          </h2>
          <p style={pStyle}>
            The core runtime is open source and ships as a single Docker image.
            Live reference instance:{' '}
            <a
              href="https://docker.floom.dev"
              target="_blank"
              rel="noreferrer"
              style={{ color: 'var(--accent)', fontWeight: 600 }}
            >
              docker.floom.dev
            </a>
            .
          </p>

          <h3 style={h3Style}>One command</h3>
          <pre style={codeBlockStyle}>{`# pulls from GitHub Container Registry, persists data in a named volume
docker run -d -p 3000:3000 \\
  -v floom_data:/data \\
  -v "$(pwd)/apps.yaml:/app/config/apps.yaml:ro" \\
  -e FLOOM_APPS_CONFIG=/app/config/apps.yaml \\
  ghcr.io/floomhq/floom-monorepo:latest`}</pre>

          <p style={pStyle}>
            Open <code>http://localhost:3000</code>, configure apps via{' '}
            <code>apps.yaml</code>, point an MCP client at{' '}
            <code>http://localhost:3000/mcp/app/&lt;slug&gt;</code>. Full guide at{' '}
            <Link to="/docs/self-host" style={{ color: 'var(--accent)' }}>
              Self-host
            </Link>
            .
          </p>

          {/* Runtime specs */}
          <h2 id="specs" style={h2Style}>
            Runtime specs
          </h2>
          <p style={pStyle}>
            What a single app run can do on Floom Cloud. Self-host has the same
            defaults and is fully configurable via env vars.
          </p>

          <table style={specTableStyle}>
            <thead>
              <tr>
                <th style={specThStyle}>Resource</th>
                <th style={specThStyle}>Limit</th>
                <th style={specThStyle}>Notes</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={specTdStyle}>Memory per run</td>
                <td style={specTdMonoStyle}>512 MB</td>
                <td style={specTdNoteStyle}>Container RSS cap. Hit = OOM-killed.</td>
              </tr>
              <tr>
                <td style={specTdStyle}>CPU per run</td>
                <td style={specTdMonoStyle}>1 vCPU</td>
                <td style={specTdNoteStyle}>Docker --cpus=1 equivalent.</td>
              </tr>
              <tr>
                <td style={specTdStyle}>Sync run timeout</td>
                <td style={specTdMonoStyle}>5 min</td>
                <td style={specTdNoteStyle}>
                  Past 300s, the container is killed.
                </td>
              </tr>
              <tr>
                <td style={specTdStyle}>Async job timeout</td>
                <td style={specTdMonoStyle}>30 min</td>
                <td style={specTdNoteStyle}>
                  Default for <code>POST /api/:slug/jobs</code>.
                </td>
              </tr>
              <tr>
                <td style={specTdStyle}>Build timeout</td>
                <td style={specTdMonoStyle}>10 min</td>
                <td style={specTdNoteStyle}>First deploy. Subsequent reuse cache.</td>
              </tr>
              <tr>
                <td style={specTdStyle}>Anon rate limit</td>
                <td style={specTdMonoStyle}>150 / h</td>
                <td style={specTdNoteStyle}>Per IP, across all apps.</td>
              </tr>
              <tr>
                <td style={specTdStyle}>Signed-in rate limit</td>
                <td style={specTdMonoStyle}>300 / h</td>
                <td style={specTdNoteStyle}>Per user, across all apps.</td>
              </tr>
            </tbody>
          </table>

          <p style={pStyle}>
            Full lifecycle of a run (validation → container boot → secrets →
            `__FLOOM_RESULT__` marker) lives at{' '}
            <Link to="/docs/runtime-specs" style={{ color: 'var(--accent)' }}>
              Runtime specs
            </Link>
            .
          </p>

          {/* Discord */}
          <div style={discordFootStyle}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <h4 style={{ fontSize: 15, fontWeight: 600, margin: '0 0 4px' }}>
                Stuck? Ask in Discord.
              </h4>
              <p
                style={{
                  fontSize: 14,
                  color: 'var(--muted)',
                  margin: 0,
                  lineHeight: 1.5,
                }}
              >
                Most questions get an answer within a few hours from the Floom team
                or a contributor.
              </p>
            </div>
            <a
              href="https://discord.gg/8fXGXjxcRz"
              target="_blank"
              rel="noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '8px 16px',
                background: 'var(--accent)',
                color: '#fff',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                textDecoration: 'none',
              }}
            >
              Open Discord
            </a>
          </div>
        </article>
      </main>

      <Footer />
      <FeedbackButton />
    </div>
  );
}
