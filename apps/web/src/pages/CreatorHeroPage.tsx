import { useEffect, useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { FloomApp } from '../components/FloomApp';
import type { AppDetail } from '../lib/types';
import { getApp } from '../api/client';

// ── Plumbing grid data ────────────────────────────────────────────────────
const PLUMBING_LIVE = [
  { name: 'MCP server', desc: 'Auto-generated from OpenAPI operations.' },
  { name: 'HTTP API', desc: 'Pass-through proxy with plumbing injection.' },
  { name: 'CLI', desc: '@floom/cli — every operation is a command.' },
  { name: 'Chat UI', desc: '/chat — describe what you want, Floom routes it.' },
  { name: 'Standalone UI + embed', desc: '/p/:slug and <FloomApp /> component.' },
  { name: 'Auto-generated forms', desc: 'Inputs typed from OpenAPI param schemas.' },
  { name: 'Secrets vault', desc: 'Per-app env vars injected at runtime.' },
  { name: 'Rate limiting', desc: 'Global + per-IP. Configurable per operation.' },
  { name: 'Streaming output', desc: 'SSE for long-running operations.' },
  { name: 'Run history', desc: 'Per-session audit log of every run.' },
];

const PLUMBING_SOON = [
  { name: 'Access control', desc: 'RBAC, per-user permissions.' },
  { name: 'Staging / preview envs', desc: 'Isolate changes before promoting.' },
  { name: 'Version control / rollback', desc: 'Roll back any app to any prior spec.' },
  { name: 'Per-app database', desc: 'Supabase-shaped, zero config.' },
  { name: 'Auth', desc: 'OAuth, SSO, passwordless.' },
  { name: 'Payment / billing', desc: 'Stripe Connect built in.' },
  { name: 'Analytics / observability', desc: 'Latency, error rates, usage heatmaps.' },
];

// Flyfast app detail built inline so hero renders immediately, before API responds.
const FLYFAST_STUB: AppDetail = {
  slug: 'flyfast',
  name: 'FlyFast',
  description: 'Search flights like you would text a friend. Up to 100 combinations from one natural-language query.',
  category: 'travel',
  author: 'buildingopen',
  icon: null,
  actions: ['search'],
  runtime: 'python',
  created_at: '',
  manifest: {
    name: 'FlyFast',
    description: 'Search flights like you would text a friend.',
    actions: {
      search: {
        label: 'Search Flights',
        description: 'Natural-language flight search.',
        inputs: [
          {
            name: 'prompt',
            label: 'What flight do you need?',
            type: 'textarea',
            required: true,
            placeholder: 'Cheap flight from Berlin to Lisbon first week of May',
          },
        ],
        outputs: [
          { name: 'results', label: 'Flight Results', type: 'json' },
        ],
      },
    },
    runtime: 'python',
    python_dependencies: ['httpx>=0.27'],
    node_dependencies: {},
    secrets_needed: ['FLYFAST_INTERNAL_TOKEN'],
    manifest_version: '2.0',
  },
};

const OPENAPI_YAML = `name: stripe
type: proxied
openapi_spec_url: https://docs.stripe.com/api/openapi.json
base_url: https://api.stripe.com
auth: bearer
secrets: [STRIPE_SECRET_KEY]`;

export function CreatorHeroPage() {
  const [demoApp, setDemoApp] = useState<AppDetail>(FLYFAST_STUB);
  const navigate = useNavigate();
  const [specInput, setSpecInput] = useState('');
  const [specModalOpen, setSpecModalOpen] = useState(false);
  const [yamlCopied, setYamlCopied] = useState(false);
  const specRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Floom — infra for agentic work';
    // Try to load the real flyfast app detail (has live run_id etc)
    getApp('flyfast').then((a) => setDemoApp(a)).catch(() => {});
  }, []);

  const handleSignIn = () => {
    navigate('/chat');
    setTimeout(() => {
      window.dispatchEvent(
        new CustomEvent('floom:pill', { detail: { pill: 'connect-github' } }),
      );
    }, 100);
  };

  const handleDeploy = (e: React.FormEvent) => {
    e.preventDefault();
    if (!specInput.trim()) return;
    setSpecModalOpen(true);
  };

  return (
    <div className="page-root" data-testid="creator-hero">
      <TopBar onSignIn={handleSignIn} />

      {/* ── Hero ─────────────────────────────────────────────────── */}
      <section
        className="main"
        style={{
          background: 'radial-gradient(ellipse at top, rgba(255,255,255,1) 0%, var(--bg) 60%)',
          paddingBottom: 64,
          borderBottom: '1px solid var(--line)',
        }}
      >
        <h1 className="headline" style={{ maxWidth: 720 }}>
          Infra for<span className="headline-dim"> agentic work.</span>
        </h1>
        <p className="subhead" style={{ maxWidth: 620 }}>
          OpenAPI in. Production product out. MCP server, CLI, HTTP API, and chat UI — auto-generated. Secrets, rate limits, streaming, access control, payments — built in.
        </p>

        <form
          onSubmit={handleDeploy}
          style={{ display: 'flex', gap: 10, maxWidth: 520, marginTop: 28, flexWrap: 'wrap' }}
        >
          <input
            ref={specRef}
            type="url"
            className="input-field"
            placeholder="https://docs.stripe.com/api/openapi.json"
            value={specInput}
            onChange={(e) => setSpecInput(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
            data-testid="spec-input"
          />
          <button
            type="submit"
            className="btn-primary"
            style={{ height: 40, padding: '0 22px', fontSize: 14 }}
            data-testid="deploy-btn"
          >
            Deploy from OpenAPI spec
          </button>
        </form>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 16 }}>
          <Link
            to="/apps"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '10px 22px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              color: 'var(--ink)',
              borderRadius: 9,
              fontSize: 14,
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            Browse 15 apps
          </Link>
          <Link
            to="/protocol"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '10px 22px',
              background: 'none',
              color: 'var(--muted)',
              borderRadius: 9,
              fontSize: 14,
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            Read the protocol →
          </Link>
        </div>
      </section>

      {/* ── Single source of truth ───────────────────────────────── */}
      <section
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '56px 24px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <p className="label-mono" style={{ marginBottom: 8 }}>The single source of truth</p>
        <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          One spec. Every surface.
        </h2>
        <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 12, maxWidth: 560 }}>
          OpenAPI is the contract. Floom is what happens next.
        </p>
        <p style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--ink)', maxWidth: 600, marginBottom: 0 }}>
          OpenAPI is how every serious API already describes itself — Stripe, GitHub, Linear, OpenAI, Anthropic, your own service. Floom takes that spec and derives every surface an agent needs to call it: MCP tools, CLI commands, HTTP endpoints, chat UI, typed SDK. Plus all the production plumbing you'd otherwise build yourself.
        </p>
      </section>

      {/* ── The manifest ─────────────────────────────────────────── */}
      <section
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '56px 24px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <p className="label-mono" style={{ marginBottom: 8 }}>The manifest</p>
        <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          Five lines of YAML.
        </h2>

        <div style={{ position: 'relative', maxWidth: 620, marginTop: 28 }}>
          <pre
            style={{
              background: 'var(--terminal-bg, #0e0e0c)',
              color: 'var(--terminal-ink, #d4d4c8)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 12,
              padding: '20px 16px',
              borderRadius: 12,
              overflowX: 'auto',
              lineHeight: 1.7,
              margin: 0,
            }}
          >
            {OPENAPI_YAML}
          </pre>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(OPENAPI_YAML).then(() => {
                setYamlCopied(true);
                setTimeout(() => setYamlCopied(false), 1500);
              });
            }}
            style={{
              position: 'absolute',
              top: 12,
              right: 12,
              fontSize: 11,
              padding: '3px 10px',
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: 6,
              color: yamlCopied ? '#7bffc0' : 'rgba(255,255,255,0.6)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              transition: 'color 0.15s',
            }}
          >
            {yamlCopied ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 16, maxWidth: 560, lineHeight: 1.6 }}>
          Floom serves the chat, the MCP server, the CLI, the HTTP endpoint, the access control, the rate limits, and the audit log — from those five lines.
        </p>
      </section>

      {/* ── Try it — embedded FloomApp demo ─────────────────────── */}
      <section
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '56px 24px',
          borderBottom: '1px solid var(--line)',
        }}
        data-testid="hero-demo"
      >
        <p className="label-mono" style={{ marginBottom: 8 }}>Try it live</p>
        <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          Run FlyFast in one click.
        </h2>
        <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 32, maxWidth: 520 }}>
          No signup. No config. Just describe the flight you want and watch the agent run.
        </p>

        <FloomApp
          app={demoApp}
          standalone={true}
          showSidebar={true}
          initialInputs={{ prompt: 'Cheap flight from Berlin to Lisbon first week of May' }}
        />
      </section>

      {/* ── Four surfaces ────────────────────────────────────────── */}
      <section
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '56px 24px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <p className="label-mono" style={{ marginBottom: 8 }}>Four surfaces, one spec</p>
        <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          Every interface. Zero extra config.
        </h2>
        <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 28, maxWidth: 520 }}>
          One OpenAPI spec. Floom generates all four automatically.
        </p>

        <div className="surface-cards">
          <SurfaceCard
            number="01"
            title="Chat UI"
            desc="Your users describe what they want. Floom routes to the right operation and runs it."
            code={`floom.dev/chat`}
          />
          <SurfaceCard
            number="02"
            title="MCP server"
            desc="Every agent from Claude Desktop to Cursor calls your app as an MCP tool."
            code={`floom.dev/mcp/app/{slug}`}
          />
          <SurfaceCard
            number="03"
            title="HTTP API"
            desc="Floom passes through with plumbing injection. Standard REST, any client."
            code={`POST /api/run`}
          />
          <SurfaceCard
            number="04"
            title="CLI"
            desc={`floom run stripe list-customers --limit=10. Every OpenAPI operation becomes a command.`}
            code={`floom run {slug} {operation}`}
          />
        </div>
      </section>

      {/* ── Full plumbing stack ───────────────────────────────────── */}
      <section
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '56px 24px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <p className="label-mono" style={{ marginBottom: 8 }}>The full production layer</p>
        <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          Not just surfaces. The whole production layer.
        </h2>
        <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 32, maxWidth: 520 }}>
          What you'd otherwise wire up yourself for every tool.
        </p>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
            gap: 12,
          }}
        >
          {PLUMBING_LIVE.map((item) => (
            <PlumbingCell key={item.name} name={item.name} desc={item.desc} live />
          ))}
          {PLUMBING_SOON.map((item) => (
            <PlumbingCell key={item.name} name={item.name} desc={item.desc} live={false} />
          ))}
        </div>
      </section>

      {/* ── Works for what's real ─────────────────────────────── */}
      <section
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '56px 24px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <p className="label-mono" style={{ marginBottom: 8 }}>Deploy what you already have</p>
        <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          Deploy what you already have.
        </h2>
        <ul style={{ margin: '20px 0', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <li style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--ink)' }}>
            Wrap an external OpenAPI spec (Stripe, GitHub, Linear, your own SaaS) — <strong>proxied mode</strong>. Paste the URL, Floom wraps it in 10 seconds.
          </li>
          <li style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--ink)' }}>
            Host your own as a FastAPI wrapper — <strong>hosted mode</strong>. Add a 20-line Python server and a <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>floom.yaml</code>. Floom builds, runs, and wraps it.
          </li>
          <li style={{ fontSize: 15, lineHeight: 1.7, color: 'var(--muted)' }}>
            If it's a GitHub repo with no OpenAPI yet, we'll auto-generate one from the README and entrypoint — coming soon.
          </li>
        </ul>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 8 }}>
          <Link to="/apps" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
            Browse the 15 apps running today →
          </Link>
        </p>
      </section>

      {/* ── Protocol is open ─────────────────────────────────────── */}
      <section
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '56px 24px',
          borderBottom: '1px solid var(--line)',
        }}
      >
        <p className="label-mono" style={{ marginBottom: 8 }}>Open by default</p>
        <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          The protocol is open.
        </h2>
        <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 24, maxWidth: 480 }}>
          <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>spec/protocol.md</code>. MIT. Self-host. Fork. Contribute.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <Link
            to="/protocol"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '10px 20px',
              background: 'var(--accent)',
              color: '#fff',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Read the spec
          </Link>
          <a
            href="https://github.com/floomhq/floom-monorepo"
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 20px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              color: 'var(--ink)',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <use href="#icon-github" />
            </svg>
            View monorepo
          </a>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────── */}
      <footer
        style={{
          maxWidth: 900,
          margin: '0 auto',
          padding: '32px 24px 48px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
          Built in Hamburg by{' '}
          <a
            href="https://github.com/federicodeponte"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--ink)', textDecoration: 'none' }}
          >
            Federico De Ponte
          </a>{' '}
          and contributors.
        </p>
        <nav style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Link to="/apps" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>apps</Link>
          <Link to="/chat" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>chat</Link>
          <Link to="/protocol" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>protocol</Link>
          <a href="https://github.com/floomhq/floom-monorepo" target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>github</a>
        </nav>
      </footer>

      {/* Deploy coming soon modal */}
      {specModalOpen && (
        <DeployModal spec={specInput} onClose={() => setSpecModalOpen(false)} />
      )}
    </div>
  );
}

function PlumbingCell({ name, desc, live }: { name: string; desc: string; live: boolean }) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '14px 16px',
        position: 'relative',
        opacity: live ? 1 : 0.7,
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 10,
          right: 10,
          fontSize: 10,
          fontWeight: 700,
          padding: '2px 7px',
          borderRadius: 4,
          background: live ? 'rgba(99,102,241,0.12)' : 'var(--bg)',
          color: live ? '#6366f1' : 'var(--muted)',
          border: live ? '1px solid rgba(99,102,241,0.25)' : '1px solid var(--line)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        {live ? 'Live' : 'Coming soon'}
      </div>
      <p style={{ margin: '0 0 4px', fontSize: 13, fontWeight: 600, color: 'var(--ink)', paddingRight: 48 }}>
        {name}
      </p>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{desc}</p>
    </div>
  );
}

function SurfaceCard({
  number,
  title,
  desc,
  code,
}: {
  number: string;
  title: string;
  desc: string;
  code: string;
}) {
  return (
    <div className="surface-card">
      <div className="surface-card-label">{number}</div>
      <div className="surface-card-title">{title}</div>
      <div className="surface-card-desc">{desc}</div>
      <code
        style={{
          display: 'block',
          marginTop: 12,
          fontFamily: 'JetBrains Mono, monospace',
          fontSize: 11,
          color: 'var(--muted)',
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          padding: '5px 10px',
          borderRadius: 6,
        }}
      >
        {code}
      </code>
    </div>
  );
}

function DeployModal({ spec, onClose }: { spec: string; onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
  };

  return (
    <>
      <div
        style={{
          position: 'fixed',
          inset: 0,
          background: 'rgba(0,0,0,0.4)',
          zIndex: 100,
        }}
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-label="Deploy coming soon"
        style={{
          position: 'fixed',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 101,
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 16,
          padding: '32px',
          maxWidth: 440,
          width: '90vw',
        }}
      >
        <p
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--accent)',
            textTransform: 'uppercase',
            letterSpacing: '0.07em',
            margin: '0 0 8px',
          }}
        >
          Coming soon
        </p>
        <h2 style={{ fontSize: 22, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          Real deploy coming soon.
        </h2>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 20px', lineHeight: 1.6 }}>
          We got your spec:{' '}
          <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{spec}</code>. Drop your email and we'll notify you the moment deploy goes live.
        </p>

        {submitted ? (
          <p style={{ fontSize: 14, color: 'var(--success)', fontWeight: 600 }}>
            You're on the list.
          </p>
        ) : (
          <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 8 }}>
            <input
              type="email"
              required
              className="input-field"
              placeholder="your@email.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ flex: 1 }}
            />
            <button type="submit" className="btn-primary" style={{ height: 40, padding: '0 18px', fontSize: 14 }}>
              Notify me
            </button>
          </form>
        )}

        <button
          type="button"
          onClick={onClose}
          style={{
            position: 'absolute',
            top: 16,
            right: 16,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
            color: 'var(--muted)',
            fontSize: 18,
            fontFamily: 'inherit',
          }}
          aria-label="Close"
        >
          ×
        </button>
      </div>
    </>
  );
}
