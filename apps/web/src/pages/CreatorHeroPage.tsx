import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { FloomApp } from '../components/FloomApp';
import { FeedbackButton } from '../components/FeedbackButton';
import {
  Server,
  Globe,
  Terminal,
  LayoutTemplate,
} from 'lucide-react';
import type { AppDetail } from '../lib/types';
import { getApp } from '../api/client';

// FlyFast stub so the demo renders immediately before the API responds
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

const DOCKER_CMD = `docker run -p 3051:3051 \\
  ghcr.io/floomhq/floom-monorepo:latest`;

const FOUR_THINGS = [
  { Icon: Server, label: 'MCP server', desc: 'Auto-generated from OpenAPI operations.' },
  { Icon: Globe, label: 'HTTP API', desc: 'Pass-through proxy with secrets injection.' },
  { Icon: Terminal, label: 'CLI', desc: '@floom/cli. Every operation is a command.' },
  { Icon: LayoutTemplate, label: 'Web', desc: 'Hosted form + output renderer at /p/:slug.' },
];

export function CreatorHeroPage() {
  const [demoApp, setDemoApp] = useState<AppDetail>(FLYFAST_STUB);
  const [dockerCopied, setDockerCopied] = useState(false);
  const [waitlistEmail, setWaitlistEmail] = useState('');
  const [waitlistState, setWaitlistState] = useState<'idle' | 'submitted' | 'error'>('idle');
  const [waitlistError, setWaitlistError] = useState('');

  useEffect(() => {
    document.title = 'Floom: infra for agentic work';
    getApp('flyfast').then((a) => setDemoApp(a)).catch(() => {});
  }, []);

  const copyDocker = () => {
    try { navigator.clipboard.writeText(DOCKER_CMD).catch(() => {}); } catch { /* ignore */ }
    setDockerCopied(true);
    setTimeout(() => setDockerCopied(false), 2000);
  };

  const handleWaitlist = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = waitlistEmail.trim();
    if (!email || !email.includes('@')) {
      setWaitlistError('Please enter a valid email.');
      return;
    }
    try {
      const res = await fetch('/api/deploy-waitlist', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) throw new Error('server error');
      setWaitlistState('submitted');
    } catch {
      setWaitlistError('Something went wrong. Try again.');
    }
  };

  return (
    <div className="page-root" data-testid="creator-hero">
      <TopBar />

      {/* Hero */}
      <section
        style={{
          borderBottom: '1px solid var(--line)',
          padding: '80px 24px 72px',
          textAlign: 'center',
        }}
      >
        <div style={{ maxWidth: 640, margin: '0 auto' }}>
          <h1 className="headline" style={{ marginBottom: 16 }}>
            Infra for<span className="headline-dim"> agentic work.</span>
          </h1>
          <p style={{ fontSize: 17, color: 'var(--muted)', margin: '0 auto 36px', maxWidth: 480, lineHeight: 1.6 }}>
            OpenAPI in. Production product out.
          </p>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link
              to="/apps"
              className="btn-primary"
              style={{ padding: '11px 24px', fontSize: 15, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
            >
              Browse live apps
            </Link>
            <a
              href="#self-host"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '11px 24px',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                color: 'var(--ink)',
                borderRadius: 9,
                fontSize: 15,
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              Self-host via Docker
            </a>
            <Link
              to="/protocol"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                padding: '11px 24px',
                background: 'none',
                color: 'var(--muted)',
                borderRadius: 9,
                fontSize: 15,
                fontWeight: 500,
                textDecoration: 'none',
              }}
            >
              Read the protocol
            </Link>
          </div>
        </div>
      </section>

      {/* Live demo */}
      <section
        data-testid="hero-demo"
        style={{ borderBottom: '1px solid var(--line)', padding: '64px 24px' }}
      >
        <div style={{ maxWidth: 700, margin: '0 auto' }}>
          <p className="label-mono" style={{ marginBottom: 8, textAlign: 'center' }}>Try it live</p>
          <h2 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)', textAlign: 'center' }}>
            Run FlyFast. No signup.
          </h2>
          <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 32, textAlign: 'center', maxWidth: 400, margin: '0 auto 32px' }}>
            Type a flight request. Click Run. See real results.
          </p>
          <FloomApp
            app={demoApp}
            standalone={true}
            showSidebar={false}
            initialInputs={{ prompt: 'Cheap flight from Berlin to Lisbon first week of May' }}
          />
        </div>
      </section>

      {/* Every Floom app gets */}
      <section style={{ borderBottom: '1px solid var(--line)', padding: '64px 24px' }}>
        <div style={{ maxWidth: 900, margin: '0 auto' }}>
          <p className="label-mono" style={{ marginBottom: 8, textAlign: 'center' }}>Every Floom app gets</p>
          <h2 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 32px', color: 'var(--ink)', textAlign: 'center' }}>
            Four surfaces. One spec.
          </h2>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))',
              gap: 16,
            }}
          >
            {FOUR_THINGS.map(({ Icon, label, desc }) => (
              <div
                key={label}
                style={{
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: '18px 20px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                <div style={{ color: 'var(--accent)' }}>
                  <Icon size={20} />
                </div>
                <p style={{ margin: 0, fontSize: 14, fontWeight: 700, color: 'var(--ink)' }}>{label}</p>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Self-host */}
      <section
        id="self-host"
        data-testid="self-host-section"
        style={{ borderBottom: '1px solid var(--line)', padding: '64px 24px' }}
      >
        <div style={{ maxWidth: 700, margin: '0 auto' }}>
          <p className="label-mono" style={{ marginBottom: 8 }}>Open source</p>
          <h2 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
            Run Floom on your own infra.
          </h2>
          <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 28, maxWidth: 480 }}>
            One command, one image, your data.
          </p>

          <div style={{ position: 'relative', marginBottom: 20 }}>
            <pre
              style={{
                background: 'var(--terminal-bg, #0e0e0c)',
                color: 'var(--terminal-ink, #d4d4c8)',
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 13,
                padding: '20px 18px',
                borderRadius: 10,
                overflowX: 'auto',
                lineHeight: 1.7,
                margin: 0,
              }}
            >
              {DOCKER_CMD}
            </pre>
            <button
              type="button"
              onClick={copyDocker}
              style={{
                position: 'absolute', top: 12, right: 12,
                fontSize: 11, padding: '3px 10px',
                background: 'rgba(255,255,255,0.1)',
                border: '1px solid rgba(255,255,255,0.15)',
                borderRadius: 6,
                color: dockerCopied ? '#7bffc0' : 'rgba(255,255,255,0.6)',
                cursor: 'pointer', fontFamily: 'inherit', transition: 'color 0.15s',
              }}
            >
              {dockerCopied ? 'Copied!' : 'Copy'}
            </button>
          </div>

          <a
            href="https://github.com/floomhq/floom-monorepo"
            target="_blank"
            rel="noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '9px 20px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              color: 'var(--ink)',
              borderRadius: 8,
              fontSize: 13,
              fontWeight: 500,
              textDecoration: 'none',
            }}
          >
            <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
              <use href="#icon-github" />
            </svg>
            View on GitHub
          </a>
        </div>
      </section>

      {/* Single honest waitlist */}
      <section style={{ padding: '64px 24px 80px' }}>
        <div
          style={{
            maxWidth: 520,
            margin: '0 auto',
            background: 'var(--card)',
            border: '1px solid var(--line)',
            borderRadius: 14,
            padding: '32px',
          }}
        >
          {waitlistState === 'submitted' ? (
            <div data-testid="waitlist-success">
              <p style={{ margin: '0 0 6px', fontSize: 16, fontWeight: 700, color: 'var(--ink)' }}>
                You're on the list.
              </p>
              <p style={{ margin: 0, fontSize: 14, color: 'var(--muted)' }}>
                We'll email you at <strong>{waitlistEmail}</strong> when creator accounts ship.
              </p>
            </div>
          ) : (
            <>
              <p style={{ margin: '0 0 4px', fontSize: 11, fontWeight: 700, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>
                Coming v1.1
              </p>
              <p style={{ margin: '0 0 8px', fontSize: 18, fontWeight: 700, color: 'var(--ink)' }}>
                Cloud deploys.
              </p>
              <p style={{ margin: '0 0 24px', fontSize: 14, color: 'var(--muted)', lineHeight: 1.6 }}>
                Want creator accounts to deploy your own apps to floom.dev? Join the list.
              </p>
              <form
                onSubmit={handleWaitlist}
                data-testid="waitlist-form"
                style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}
              >
                <input
                  type="email"
                  required
                  className="input-field"
                  placeholder="your@email.com"
                  value={waitlistEmail}
                  onChange={(e) => { setWaitlistEmail(e.target.value); setWaitlistError(''); }}
                  style={{ flex: 1, minWidth: 200 }}
                  data-testid="waitlist-email-input"
                />
                <button
                  type="submit"
                  className="btn-primary"
                  style={{ height: 40, padding: '0 22px', fontSize: 14 }}
                  data-testid="waitlist-notify-btn"
                >
                  Join waitlist
                </button>
                {waitlistError && (
                  <p style={{ width: '100%', margin: '4px 0 0', fontSize: 12, color: '#ef4444' }}>{waitlistError}</p>
                )}
              </form>
            </>
          )}
        </div>
      </section>

      {/* Footer */}
      <footer
        style={{
          maxWidth: 1200,
          margin: '0 auto',
          padding: '24px 24px 40px',
          display: 'flex',
          flexWrap: 'wrap',
          gap: 16,
          alignItems: 'center',
          justifyContent: 'space-between',
          borderTop: '1px solid var(--line)',
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
          and contributors. MIT licensed.
        </p>
        <nav style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <Link to="/apps" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>apps</Link>
          <Link to="/protocol" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>protocol</Link>
          <a href="https://github.com/floomhq/floom-monorepo" target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>github</a>
        </nav>
      </footer>
      <FeedbackButton />
    </div>
  );
}
