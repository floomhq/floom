// /docs/limits: runtime and limits, plain English.
//
// Fixes #298. Technical founders who consider building on Floom want to
// know the hard numbers before they commit: how long their app gets to
// run, how much memory it gets, what happens under load, and when to
// reach for proxied mode instead. Today those numbers live in code
// (services/docker.ts, lib/rate-limit.ts, lib/byok-gate.ts) and prod
// compose (/opt/floom-mcp-preview/docker-compose.yml). This page
// surfaces them in one place, in plain English, with no marketing
// hedging.
//
// Source of truth: the constants at the top of SECTIONS below match the
// defaults shipped on floom.dev as of 2026-04-22. If the runtime caps
// change (e.g. RUNNER_MEMORY bumped to 1g), update this page in the
// same PR so the two never drift.
//
// Style rules (from Federico, non-negotiable):
//   - No em dashes. Commas, colons, semicolons only.
//   - Lead with outcome, not mechanism.
//   - Jargon gets a one-sentence unpack on first use.
//   - Numbers in a table.

import { Link } from 'react-router-dom';
import { PageShell } from '../components/PageShell';

const SECTION_STYLE: React.CSSProperties = {
  maxWidth: 820,
  margin: '0 auto',
  padding: '40px 0',
};

const EYEBROW_STYLE: React.CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  fontWeight: 700,
  color: 'var(--muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  margin: '0 0 12px',
};

const H1_STYLE: React.CSSProperties = {
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontWeight: 400,
  fontSize: 48,
  lineHeight: 1.1,
  letterSpacing: '-0.025em',
  color: 'var(--ink)',
  margin: '0 0 20px',
  textWrap: 'balance' as unknown as 'balance',
};

const SUB_STYLE: React.CSSProperties = {
  fontSize: 18,
  lineHeight: 1.6,
  color: 'var(--muted)',
  margin: '0 auto',
  maxWidth: 620,
};

const H2_STYLE: React.CSSProperties = {
  fontFamily: "'DM Serif Display', Georgia, serif",
  fontWeight: 400,
  fontSize: 28,
  letterSpacing: '-0.01em',
  color: 'var(--ink)',
  margin: '0 0 16px',
};

const BODY_STYLE: React.CSSProperties = {
  fontSize: 16,
  lineHeight: 1.65,
  color: 'var(--ink)',
  margin: '0 0 14px',
};

const MUTED_BODY_STYLE: React.CSSProperties = {
  ...BODY_STYLE,
  color: 'var(--muted)',
};

const TABLE_WRAP_STYLE: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 12,
  overflow: 'hidden',
  background: 'var(--card)',
};

const TABLE_STYLE: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 14,
};

const TH_STYLE: React.CSSProperties = {
  textAlign: 'left',
  padding: '12px 16px',
  background: 'var(--card)',
  borderBottom: '1px solid var(--line)',
  color: 'var(--muted)',
  fontWeight: 600,
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
};

const TD_STYLE: React.CSSProperties = {
  padding: '14px 16px',
  borderBottom: '1px solid var(--line)',
  color: 'var(--ink)',
  verticalAlign: 'top',
};

const TD_VALUE_STYLE: React.CSSProperties = {
  ...TD_STYLE,
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 13,
  whiteSpace: 'nowrap',
};

const CALLOUT_STYLE: React.CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 12,
  padding: '18px 20px',
  margin: '8px 0 20px',
};

interface LimitRow {
  what: string;
  value: string;
  plain: string;
}

// Verified against:
//   - apps/server/src/services/docker.ts (RUNNER_TIMEOUT, RUNNER_MEMORY,
//     RUNNER_CPUS, BUILD_TIMEOUT)
//   - apps/server/src/lib/rate-limit.ts (150/300/500 per-hour defaults)
//   - apps/server/src/lib/byok-gate.ts (5 free runs per IP per 24h on
//     BYOK-gated demo slugs)
//   - /opt/floom-mcp-preview/docker-compose.yml (prod matches defaults)
const LIMITS: LimitRow[] = [
  {
    what: 'Max runtime per run',
    value: '300 seconds',
    plain: 'Your app gets 5 minutes to return a result. After that, we kill the container and mark the run as timed out.',
  },
  {
    what: 'Memory per run',
    value: '512 MB',
    plain: 'If your process goes past 512 MB, Docker kills it and we mark the run as out-of-memory.',
  },
  {
    what: 'CPU per run',
    value: '1 core',
    plain: 'Each run gets one CPU core. Multi-process or multi-threaded apps share that one core, they do not get more.',
  },
  {
    what: 'Build timeout',
    value: '600 seconds',
    plain: 'First time we build your Docker image, we give it up to 10 minutes. This only happens when you publish or update an app, not on every run.',
  },
  {
    what: 'Concurrent runs per app',
    value: 'No hard cap',
    plain: 'We do not limit how many runs of your app can execute at once. The rate limits below do the real work.',
  },
  {
    what: 'Rate limit, signed out',
    value: '150 runs / hour / IP',
    plain: 'Anonymous visitors share a bucket keyed on their IP.',
  },
  {
    what: 'Rate limit, signed in',
    value: '300 runs / hour / user',
    plain: 'Signing in gives you double the anon budget, tied to your account instead of your IP.',
  },
  {
    what: 'Per (IP, app) rate limit',
    value: '500 runs / hour',
    plain: 'One viewer cannot monopolize one app. Independent of the anon and user caps above.',
  },
  {
    what: 'Free runs on demo apps',
    value: '5 runs / 24 h / visitor',
    plain: 'On the three demo apps Floom pays for (lead-scorer, competitor-analyzer, resume-screener), anonymous visitors get 5 free runs per day. After that, they add their own Gemini API key to keep going.',
  },
];

export function LimitsPage() {
  return (
    <PageShell
      title="Runtime and limits · Floom"
      contentStyle={{ padding: '24px 24px 80px', maxWidth: 900 }}
    >
      <section
        data-testid="limits-hero"
        style={{ ...SECTION_STYLE, padding: '72px 0 16px', textAlign: 'center' }}
      >
        <p style={{ ...EYEBROW_STYLE, textAlign: 'center' }}>Docs / Runtime and limits</p>
        <h1 style={H1_STYLE}>How Floom runs your app</h1>
        <p style={SUB_STYLE}>
          Your app gets 5 minutes, 512 MB, and 1 CPU core per run, in a
          fresh container that we throw away when the run ends. Here are
          the details, with no marketing hedging.
        </p>
      </section>

      <section data-testid="limits-model" style={SECTION_STYLE}>
        <h2 style={H2_STYLE}>One container per run</h2>
        <p style={BODY_STYLE}>
          Every time someone runs your app, we start a fresh Docker
          container from your app's image, hand it the inputs, wait for
          the result, then throw the container away. Each run is isolated
          from every other run, before it and after it.
        </p>
        <p style={MUTED_BODY_STYLE}>
          Nothing survives between runs. Files your code writes to disk,
          environment changes, cached data: all gone the moment the
          container exits. If you need state that outlives a single run,
          store it somewhere your app can reach from inside the container,
          for example Postgres, S3, or a Redis you host.
        </p>
      </section>

      <section data-testid="limits-table-section" style={SECTION_STYLE}>
        <h2 style={H2_STYLE}>The numbers</h2>
        <div style={TABLE_WRAP_STYLE}>
          <table style={TABLE_STYLE} data-testid="limits-table">
            <thead>
              <tr>
                <th style={TH_STYLE}>Limit</th>
                <th style={TH_STYLE}>Value</th>
                <th style={TH_STYLE}>What it means</th>
              </tr>
            </thead>
            <tbody>
              {LIMITS.map((row) => (
                <tr key={row.what}>
                  <td style={TD_STYLE}>{row.what}</td>
                  <td style={TD_VALUE_STYLE}>{row.value}</td>
                  <td style={TD_STYLE}>{row.plain}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p style={{ ...MUTED_BODY_STYLE, fontSize: 13, margin: '12px 2px 0' }}>
          Numbers verified against the code that runs floom.dev on
          2026-04-22. Self-hosted instances can override any of these
          through <code>RUNNER_TIMEOUT</code>, <code>RUNNER_MEMORY</code>,
          <code> RUNNER_CPUS</code>, and <code>BUILD_TIMEOUT</code>.
        </p>
      </section>

      <section data-testid="limits-scaling" style={SECTION_STYLE}>
        <h2 style={H2_STYLE}>Auto-scaling: not yet</h2>
        <p style={BODY_STYLE}>
          Floom runs on a single server today. If demand spikes past what
          one server can handle, new runs queue behind running ones
          instead of spinning up more capacity. This is a conscious
          trade-off for launch, not a surprise.
        </p>
        <p style={MUTED_BODY_STYLE}>
          Multi-replica autoscaling is on the roadmap below, not shipped.
          If you expect sustained high traffic, self-host the same Docker
          image on your own infra and scale it however you like.
        </p>
      </section>

      <section data-testid="limits-cold-start" style={SECTION_STYLE}>
        <h2 style={H2_STYLE}>Cold starts</h2>
        <p style={BODY_STYLE}>
          The first run of an app after you publish it is slower than
          later runs. We build your Docker image on publish (up to 10
          minutes, usually much less), and the first container start pays
          the cost of unpacking the image layers onto disk. After that,
          each run only pays container-start overhead, typically under a
          second.
        </p>
        <p style={MUTED_BODY_STYLE}>
          If an app has not run in a while, the image stays on disk, so
          there is no second cold-start penalty. Only the initial
          publish-and-run is slow.
        </p>
      </section>

      <section data-testid="limits-proxied" style={SECTION_STYLE}>
        <h2 style={H2_STYLE}>When your app needs more, use proxied mode</h2>
        <p style={BODY_STYLE}>
          If your app needs more than 5 minutes to run, more than 512 MB
          of memory, a GPU, or any resource Floom's runtime does not give
          you, host it yourself and point Floom at it through proxied
          mode. You run the API somewhere you control; Floom handles the
          manifest, inputs, outputs, rate limits, and share links.
        </p>
        <div style={CALLOUT_STYLE}>
          <p style={{ ...BODY_STYLE, margin: 0 }}>
            In plain English: <strong>container mode</strong> means Floom
            runs your code. <strong>Proxied mode</strong> means Floom
            forwards a request to an API you host. Same manifest, same
            share page, no container limits.
          </p>
        </div>
        <p style={MUTED_BODY_STYLE}>
          See the{' '}
          <Link to="/protocol" style={{ color: 'var(--ink)' }}>
            protocol page
          </Link>{' '}
          for the OpenAPI spec shape proxied apps use.
        </p>
      </section>

      <section data-testid="limits-roadmap" style={SECTION_STYLE}>
        <h2 style={H2_STYLE}>What is coming next</h2>
        <p style={BODY_STYLE}>
          Near-term, in roughly this order:
        </p>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: '0 0 14px',
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
          }}
        >
          <li style={{ ...BODY_STYLE, margin: 0, display: 'flex', gap: 10 }}>
            <span aria-hidden="true" style={{ color: 'var(--muted)' }}>·</span>
            <span>
              <strong>Job queue for long runs.</strong> Shipped in
              v0.3.0 for async jobs with webhook callbacks. Default
              timeout 30 minutes, configurable per app.
            </span>
          </li>
          <li style={{ ...BODY_STYLE, margin: 0, display: 'flex', gap: 10 }}>
            <span aria-hidden="true" style={{ color: 'var(--muted)' }}>·</span>
            <span>
              <strong>File uploads.</strong> Shipped. Your app's inputs
              can include files, passed into the container as read-only
              paths under <code>/floom/inputs/</code>.
            </span>
          </li>
          <li style={{ ...BODY_STYLE, margin: 0, display: 'flex', gap: 10 }}>
            <span aria-hidden="true" style={{ color: 'var(--muted)' }}>·</span>
            <span>
              <strong>Streaming output.</strong> Not yet. Runs return one
              JSON result at the end today; incremental token streaming
              is on the protocol roadmap.
            </span>
          </li>
          <li style={{ ...BODY_STYLE, margin: 0, display: 'flex', gap: 10 }}>
            <span aria-hidden="true" style={{ color: 'var(--muted)' }}>·</span>
            <span>
              <strong>Session state.</strong> Not yet. Apps are stateless
              across runs today; chat-style sessions with server-held
              context are planned.
            </span>
          </li>
          <li style={{ ...BODY_STYLE, margin: 0, display: 'flex', gap: 10 }}>
            <span aria-hidden="true" style={{ color: 'var(--muted)' }}>·</span>
            <span>
              <strong>Persistent storage.</strong> Not yet. Bring your
              own database if you need it.
            </span>
          </li>
          <li style={{ ...BODY_STYLE, margin: 0, display: 'flex', gap: 10 }}>
            <span aria-hidden="true" style={{ color: 'var(--muted)' }}>·</span>
            <span>
              <strong>Multi-replica autoscaling.</strong> Not yet. Queue
              behind single-replica today, self-host if you need scale
              now.
            </span>
          </li>
        </ul>
        <p style={MUTED_BODY_STYLE}>
          Track changes on{' '}
          <a
            href="https://github.com/floomhq/floom/releases"
            style={{ color: 'var(--ink)' }}
          >
            GitHub releases
          </a>
          .
        </p>
      </section>

      <section
        data-testid="limits-footer-cta"
        style={{
          ...SECTION_STYLE,
          padding: '40px 0',
          borderTop: '1px solid var(--line)',
          textAlign: 'center',
        }}
      >
        <p style={MUTED_BODY_STYLE}>
          Questions about a number on this page?{' '}
          <a
            href="https://github.com/floomhq/floom/issues/new"
            style={{ color: 'var(--ink)' }}
          >
            Open an issue
          </a>
          {' '}or read the{' '}
          <Link to="/protocol" style={{ color: 'var(--ink)' }}>
            full protocol spec
          </Link>
          .
        </p>
      </section>
    </PageShell>
  );
}
