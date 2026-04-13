import { useEffect, useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { FloomApp } from '../components/FloomApp';
import type { AppDetail } from '../lib/types';
import { getApp } from '../api/client';

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

const FLYFAST_YAML = `name: FlyFast
display_name: FlyFast
description: "Search flights like you would text a friend."
creator: "@buildingopen"
category: travel
runtime: python3.12
build: pip install -r requirements.txt
run: python -m flyfast.search "\${query}"
inputs:
  - name: query
    type: string
    required: true
    label: "What flight do you need?"
    placeholder: "cheap flights from Berlin to Lisbon next week"
outputs:
  type: json
  field: results
secrets:
  - FLYFAST_INTERNAL_TOKEN
memory_mb: 512
timeout: 60s`;

export function CreatorHeroPage() {
  const [demoApp, setDemoApp] = useState<AppDetail>(FLYFAST_STUB);
  const navigate = useNavigate();
  const [deployInput, setDeployInput] = useState('');
  const [deployModalOpen, setDeployModalOpen] = useState(false);
  const [yamlCopied, setYamlCopied] = useState(false);
  const deployRef = useRef<HTMLInputElement>(null);

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
    if (!deployInput.trim()) return;
    setDeployModalOpen(true);
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
        <p className="subhead" style={{ maxWidth: 600 }}>
          One manifest. Every agent surface. Any CLI, MCP server, or Python library becomes a chat, a tool call, and an HTTP endpoint in 10 seconds.
        </p>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 28 }}>
          <Link
            to="/apps"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              padding: '10px 22px',
              background: 'var(--accent)',
              color: '#fff',
              borderRadius: 9,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Browse 15 live apps
          </Link>
          <Link
            to="/protocol"
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
            Read the protocol
          </Link>
          <Link
            to="/chat"
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
            Open chat
          </Link>
        </div>
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
        <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 28, maxWidth: 520 }}>
          Drop a <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>floom.yaml</code> in your repo. Floom generates four surfaces from it automatically.
        </p>

        <div style={{ position: 'relative', maxWidth: 620 }}>
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
            {FLYFAST_YAML}
          </pre>
          <button
            type="button"
            onClick={() => {
              navigator.clipboard.writeText(FLYFAST_YAML).then(() => {
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
        <p className="label-mono" style={{ marginBottom: 8 }}>Four surfaces, one manifest</p>
        <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          Every interface. Zero extra config.
        </h2>
        <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 28, maxWidth: 520 }}>
          The same <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>floom.yaml</code> generates all four automatically.
        </p>

        <div className="surface-cards">
          <SurfaceCard
            number="01"
            title="Chat UI"
            desc="Users describe what they want. Floom routes to the right app. Natural language in, structured output out."
            code={`floom.dev/chat`}
          />
          <SurfaceCard
            number="02"
            title="MCP server"
            desc="Agents call your app via any MCP-compliant client. Paste the URL into Claude Desktop or Cursor."
            code={`floom.dev/mcp/app/{slug}`}
          />
          <SurfaceCard
            number="03"
            title="HTTP API"
            desc="Standard REST endpoint. Any client. Any language. Post inputs, get a run_id, stream via SSE."
            code={`POST /api/run`}
          />
          <SurfaceCard
            number="04"
            title="CLI tool"
            desc="Run any app from the terminal. Pipe into scripts, cron jobs, CI pipelines."
            code={`floom run {slug} --query=hello`}
          />
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
        <p className="label-mono" style={{ marginBottom: 8 }}>Deploy in 10-25 seconds</p>
        <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
          Works for what's real.
        </h2>
        <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 12, maxWidth: 560 }}>
          Built for MCP servers, Python libraries, and CLIs with standard entrypoints. Bring any public GitHub repo.
        </p>

        <form
          onSubmit={handleDeploy}
          style={{
            display: 'flex',
            gap: 10,
            maxWidth: 520,
            marginBottom: 16,
            flexWrap: 'wrap',
          }}
        >
          <input
            ref={deployRef}
            type="url"
            className="input-field"
            placeholder="https://github.com/owner/repo"
            value={deployInput}
            onChange={(e) => setDeployInput(e.target.value)}
            style={{ flex: 1, minWidth: 200 }}
            data-testid="deploy-input"
          />
          <button
            type="submit"
            className="btn-primary"
            style={{ height: 40, padding: '0 22px', fontSize: 14 }}
            data-testid="deploy-btn"
          >
            Deploy
          </button>
        </form>

        <p style={{ fontSize: 13, color: 'var(--muted)' }}>
          Or{' '}
          <Link to="/apps" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
            browse the 15 apps running today
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
      {deployModalOpen && (
        <DeployModal repo={deployInput} onClose={() => setDeployModalOpen(false)} />
      )}
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

function DeployModal({ repo, onClose }: { repo: string; onClose: () => void }) {
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
          One-click deploy is almost ready.
        </h2>
        <p style={{ fontSize: 14, color: 'var(--muted)', margin: '0 0 20px', lineHeight: 1.6 }}>
          We registered{' '}
          <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 12 }}>{repo}</code>. Drop your email and we'll notify you the moment deploy goes live.
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
