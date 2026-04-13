import { useEffect, useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { FloomApp } from '../components/FloomApp';
import {
  Server,
  Globe,
  Terminal,
  MessageSquare,
  Frame,
  KeyRound,
  Gauge,
  RadioTower,
  Clock,
  Shield,
  GitBranch,
  History,
  Database,
  Lock,
  CreditCard,
  BarChart3,
  FormInput,
} from 'lucide-react';
import type { AppDetail } from '../lib/types';
import { getApp } from '../api/client';

// ── Plumbing grid data ────────────────────────────────────────────────────
const PLUMBING_LIVE = [
  { name: 'MCP server', desc: 'Auto-generated from OpenAPI operations.', Icon: Server },
  { name: 'HTTP API', desc: 'Pass-through proxy with plumbing injection.', Icon: Globe },
  { name: 'CLI', desc: '@floom/cli. Every operation is a command.', Icon: Terminal },
  { name: 'Chat UI', desc: 'Describe what you want, Floom routes it.', Icon: MessageSquare },
  { name: 'Standalone UI + embed', desc: '/p/:slug and <FloomApp /> component.', Icon: Frame },
  { name: 'Auto-generated forms', desc: 'Inputs typed from OpenAPI param schemas.', Icon: FormInput },
  { name: 'Secrets vault', desc: 'Per-app env vars injected at runtime.', Icon: KeyRound },
  { name: 'Rate limiting', desc: 'Global + per-IP. Configurable per operation.', Icon: Gauge },
  { name: 'Streaming output', desc: 'SSE for long-running operations.', Icon: RadioTower },
  { name: 'Run history', desc: 'Per-session audit log of every run.', Icon: Clock },
];

const PLUMBING_SOON = [
  { name: 'Access control', desc: 'RBAC, per-user permissions.', Icon: Shield },
  { name: 'Staging / preview envs', desc: 'Isolate changes before promoting.', Icon: GitBranch },
  { name: 'Version control / rollback', desc: 'Roll back any app to any prior spec.', Icon: History },
  { name: 'Per-app database', desc: 'Supabase-shaped, zero config.', Icon: Database },
  { name: 'Auth', desc: 'OAuth, SSO, passwordless.', Icon: Lock },
  { name: 'Payment / billing', desc: 'Stripe Connect built in.', Icon: CreditCard },
  { name: 'Analytics / observability', desc: 'Latency, error rates, usage heatmaps.', Icon: BarChart3 },
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

const STRIPE_YAML = `name: stripe
type: proxied
openapi_spec_url: https://docs.stripe.com/api/openapi.json
base_url: https://api.stripe.com
auth: bearer
secrets: [STRIPE_SECRET_KEY]`;

const FLYFAST_YAML = `name: flyfast
type: hosted
runtime: python3.12
openapi_spec: ./openapi.yaml
build: pip install .
run: uvicorn flyfast.server:app --port 8000`;

const DOCKER_CMD = `docker run -p 3000:3000 \\
  -e OPENAI_API_KEY=... \\
  ghcr.io/floomhq/floom:latest`;

const NPM_CMD = `npm install @floom/runtime`;

const NPM_IMPORT = `import { runApp } from '@floom/runtime';

const result = await runApp({
  manifest, inputs, secrets,
  onStream: (chunk) => console.log(chunk),
});`;

// Social proof logos (inline SVG paths from SimpleIcons)
const BRAND_LOGOS = [
  {
    name: 'Stripe',
    svg: (
      <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-label="Stripe">
        <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305z" />
      </svg>
    ),
  },
  {
    name: 'GitHub',
    svg: (
      <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-label="GitHub">
        <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
      </svg>
    ),
  },
  {
    name: 'Linear',
    svg: (
      <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-label="Linear">
        <path d="M3.076 12.018a9 9 0 0 0 8.906 8.906l-8.906-8.906zm0-.706L12.688 20.924A9 9 0 0 0 20.924 12.688L3.076 11.312zm17.47-1.406L12.094 2.454a9 9 0 0 0-9.64 9.64l17.092-1.188zm-8.484-8.16l8.16 8.16a9 9 0 0 0-8.16-8.16z" />
      </svg>
    ),
  },
  {
    name: 'OpenAI',
    svg: (
      <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-label="OpenAI">
        <path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.032.067L9.57 19.9a4.496 4.496 0 0 1-5.97-1.597zM2.18 7.647a4.482 4.482 0 0 1 2.342-1.974V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.18 7.647zm16.59 3.865l-5.843-3.369 2.02-1.168a.076.076 0 0 1 .071 0l4.83 2.786a4.494 4.494 0 0 1-.676 8.105v-5.93a.79.79 0 0 0-.402-.424zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.237 8.89V6.557a.08.08 0 0 1 .032-.067l4.764-2.752a4.492 4.492 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.81a4.492 4.492 0 0 1 7.375-3.44l-.142.08-4.778 2.758a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.993l-2.602 1.5-2.607-1.5z" />
      </svg>
    ),
  },
  {
    name: 'Anthropic',
    svg: (
      <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-label="Anthropic">
        <path d="M17.3326 0h-3.9583L24 24h3.9583L17.3326 0zm-10.6651 0L0 24h4.0416l1.3693-3.8305h7.0082L13.789 24h4.0416L10.8313 0H6.6675zm.4992 16.4837 2.4743-6.9246 2.4743 6.9246H7.1667z" />
      </svg>
    ),
  },
  {
    name: 'Notion',
    svg: (
      <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-label="Notion">
        <path d="M4.459 4.208c.746.606 1.026.56 2.428.466l13.215-.793c.28 0 .047-.28-.046-.326L17.86 1.968c-.42-.326-.981-.7-2.055-.607L3.01 2.295c-.466.046-.56.28-.374.466zm.793 3.08v13.904c0 .747.373 1.027 1.214.98l14.523-.84c.841-.046.935-.56.935-1.167V6.354c0-.606-.233-.933-.748-.887l-15.177.887c-.56.047-.747.327-.747.933zm14.337.745c.093.42 0 .84-.42.888l-.7.14v10.264c-.608.327-1.168.514-1.635.514-.748 0-.935-.234-1.495-.933l-4.577-7.186v6.952L12.21 19s0 .84-1.168.84l-3.222.186c-.093-.186 0-.653.327-.746l.84-.233V9.854L7.822 9.76c-.094-.42.14-1.026.793-1.073l3.456-.233 4.764 7.279v-6.44l-1.215-.14c-.093-.514.28-.887.747-.933zM1.936 1.035l13.31-.98c1.634-.14 2.055-.047 3.082.7l4.249 2.986c.7.513.934.653.934 1.213v16.378c0 1.026-.373 1.634-1.68 1.726l-15.458.934c-.98.047-1.448-.093-1.962-.747l-3.129-4.06c-.56-.747-.793-1.306-.793-1.96V2.667c0-.839.374-1.54 1.447-1.632z" />
      </svg>
    ),
  },
  {
    name: 'Slack',
    svg: (
      <svg viewBox="0 0 24 24" width={18} height={18} fill="currentColor" aria-label="Slack">
        <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zm10.122 2.521a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.268 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zm-2.523 10.122a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.268a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z" />
      </svg>
    ),
  },
];

export function CreatorHeroPage() {
  const [demoApp, setDemoApp] = useState<AppDetail>(FLYFAST_STUB);
  const navigate = useNavigate();
  const [specInput, setSpecInput] = useState('');
  const [waitlistEmail, setWaitlistEmail] = useState('');
  const [waitlistStep, setWaitlistStep] = useState<'idle' | 'email' | 'submitted'>('idle');
  const [waitlistError, setWaitlistError] = useState('');
  const [yamlCopied, setYamlCopied] = useState(false);
  const [dockerCopied, setDockerCopied] = useState(false);
  const [npmCopied, setNpmCopied] = useState(false);
  const specRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Floom: infra for agentic work';
    getApp('flyfast').then((a) => setDemoApp(a)).catch(() => {});
  }, []);

  const handleSignIn = () => {
    navigate('/apps');
  };

  const handleDeploy = (e: React.FormEvent) => {
    e.preventDefault();
    if (!specInput.trim()) return;
    setWaitlistStep('email');
    setWaitlistError('');
  };

  const handleWaitlistSubmit = async (e: React.FormEvent) => {
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
        body: JSON.stringify({ email, spec_url: specInput }),
      });
      if (!res.ok) throw new Error('server error');
      setWaitlistStep('submitted');
    } catch {
      setWaitlistError('Something went wrong. Try again.');
    }
  };

  const copy = (text: string, setter: (v: boolean) => void) => {
    try { navigator.clipboard.writeText(text).catch(() => {}); } catch { /* ignore */ }
    setter(true);
    setTimeout(() => setter(false), 2000);
  };

  return (
    <div className="page-root" data-testid="creator-hero">
      <TopBar onSignIn={handleSignIn} />

      {/* ── Hero (2-col) ─────────────────────────────────────────── */}
      <section
        style={{
          background: 'radial-gradient(ellipse at top, rgba(255,255,255,1) 0%, var(--bg) 60%)',
          borderBottom: '1px solid var(--line)',
          padding: '64px 24px 56px',
        }}
      >
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <div className="hero-2col">
            {/* Left: text + CTA */}
            <div className="hero-2col-left">
              <h1 className="headline" style={{ maxWidth: 520 }}>
                Infra for<span className="headline-dim"> agentic work.</span>
              </h1>
              <p style={{ fontSize: 16, color: 'var(--muted)', margin: '16px 0 0', maxWidth: 440, lineHeight: 1.65 }}>
                OpenAPI in. MCP server, CLI, HTTP API, and UI out. Secrets, rate limits, streaming: built in.
              </p>

              {waitlistStep === 'submitted' ? (
                <div
                  data-testid="waitlist-success"
                  style={{ marginTop: 28, padding: '14px 18px', background: 'var(--card)', border: '1px solid var(--line)', borderRadius: 10, maxWidth: 460 }}
                >
                  <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600, color: 'var(--ink)' }}>
                    You're on the list.
                  </p>
                  <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                    Real deploys ship in v1.1. We'll email you at: <strong>{waitlistEmail}</strong>
                  </p>
                </div>
              ) : waitlistStep === 'email' ? (
                <form
                  onSubmit={handleWaitlistSubmit}
                  data-testid="waitlist-email-form"
                  style={{ display: 'flex', gap: 10, maxWidth: 460, marginTop: 28, flexWrap: 'wrap' }}
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
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="btn-primary"
                    style={{ height: 40, padding: '0 22px', fontSize: 14 }}
                    data-testid="waitlist-notify-btn"
                  >
                    Notify me
                  </button>
                  {waitlistError && (
                    <p style={{ width: '100%', margin: '4px 0 0', fontSize: 12, color: '#ef4444' }}>{waitlistError}</p>
                  )}
                </form>
              ) : (
                <form
                  onSubmit={handleDeploy}
                  style={{ display: 'flex', gap: 10, maxWidth: 460, marginTop: 28, flexWrap: 'wrap' }}
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
                    Deploy from spec
                  </button>
                </form>
              )}

              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 20 }}>
                <Link
                  to="/apps"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '9px 20px',
                    background: 'var(--card)',
                    border: '1px solid var(--line)',
                    color: 'var(--ink)',
                    borderRadius: 9,
                    fontSize: 13,
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
                    padding: '9px 20px',
                    background: 'none',
                    color: 'var(--muted)',
                    borderRadius: 9,
                    fontSize: 13,
                    fontWeight: 500,
                    textDecoration: 'none',
                  }}
                >
                  Read the protocol
                </Link>
              </div>
            </div>

            {/* Right: YAML manifest visual */}
            <div className="hero-2col-right" aria-hidden="true">
              <div className="hero-manifest-card">
                <div style={{ position: 'relative' }}>
                  <p style={{ margin: '0 0 8px', fontSize: 11, fontWeight: 700, color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', letterSpacing: '0.07em', fontFamily: 'JetBrains Mono, monospace' }}>floom.yaml</p>
                  <pre className="hero-manifest-pre">{STRIPE_YAML}</pre>
                </div>
                {/* Arrow */}
                <div style={{ display: 'flex', justifyContent: 'center', margin: '12px 0' }}>
                  <svg width={24} height={32} viewBox="0 0 24 32" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <line x1="12" y1="0" x2="12" y2="24" stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeDasharray="4 3" />
                    <path d="M6 22 L12 30 L18 22" stroke="rgba(255,255,255,0.4)" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
                {/* 4 surfaces */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                  {[
                    { icon: <Server size={14} />, label: 'MCP server' },
                    { icon: <Terminal size={14} />, label: 'CLI' },
                    { icon: <Globe size={14} />, label: 'HTTP API' },
                    { icon: <MessageSquare size={14} />, label: 'Chat UI' },
                  ].map(({ icon, label }) => (
                    <div key={label} style={{
                      background: 'rgba(255,255,255,0.07)',
                      border: '1px solid rgba(255,255,255,0.12)',
                      borderRadius: 8,
                      padding: '10px 12px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      color: 'rgba(255,255,255,0.75)',
                      fontSize: 12,
                      fontWeight: 500,
                      fontFamily: 'JetBrains Mono, monospace',
                    }}>
                      {icon}
                      {label}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Social proof row */}
          <div className="social-proof-row" style={{ marginTop: 48 }}>
            <span style={{ fontSize: 12, color: 'var(--muted)', fontWeight: 500, letterSpacing: '0.04em', textTransform: 'uppercase' }}>Works with</span>
            <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'center' }}>
              {BRAND_LOGOS.map(({ name, svg }) => (
                <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--muted)', opacity: 0.7 }}>
                  {svg}
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{name}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* ── The manifest (2-col: YAML left, outputs right) ────────── */}
      <section style={{ borderBottom: '1px solid var(--line)', padding: '64px 24px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <p className="label-mono" style={{ marginBottom: 8 }}>The manifest</p>
          <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
            Five lines of YAML. Every surface.
          </h2>
          <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 36, maxWidth: 520 }}>
            One spec. Floom derives the rest.
          </p>

          <div className="manifest-2col">
            {/* Left: YAML */}
            <div>
              <p style={{ margin: '0 0 10px', fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Proxied mode (wrap any API)</p>
              <div style={{ position: 'relative' }}>
                <pre
                  style={{
                    background: 'var(--terminal-bg, #0e0e0c)',
                    color: 'var(--terminal-ink, #d4d4c8)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 12,
                    padding: '20px 16px',
                    borderRadius: 12,
                    overflowX: 'auto',
                    lineHeight: 1.8,
                    margin: 0,
                  }}
                >
                  {STRIPE_YAML}
                </pre>
                <button
                  type="button"
                  data-testid="yaml-copy-btn"
                  onClick={() => copy(STRIPE_YAML, setYamlCopied)}
                  style={{
                    position: 'absolute', top: 12, right: 12,
                    fontSize: 11, padding: '3px 10px',
                    background: 'rgba(255,255,255,0.1)',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: 6,
                    color: yamlCopied ? '#7bffc0' : 'rgba(255,255,255,0.6)',
                    cursor: 'pointer', fontFamily: 'inherit', transition: 'color 0.15s',
                  }}
                >
                  {yamlCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>

              <p style={{ margin: '20px 0 10px', fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Hosted mode (Floom runs your app)</p>
              <pre
                style={{
                  background: 'var(--terminal-bg, #0e0e0c)',
                  color: 'var(--terminal-ink, #d4d4c8)',
                  fontFamily: 'JetBrains Mono, monospace',
                  fontSize: 12,
                  padding: '20px 16px',
                  borderRadius: 12,
                  overflowX: 'auto',
                  lineHeight: 1.8,
                  margin: 0,
                }}
              >
                {FLYFAST_YAML}
              </pre>
            </div>

            {/* Right: what gets generated */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <p style={{ margin: '0 0 6px', fontSize: 12, fontWeight: 600, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>What gets generated</p>
              <OutputCard
                icon={<Server size={16} />}
                title="MCP server"
                snippet={`{ "method": "tools/call",\n  "params": { "name": "stripe_list-customers",\n    "arguments": { "limit": 10 } } }`}
              />
              <OutputCard
                icon={<Terminal size={16} />}
                title="CLI"
                snippet={`$ floom run stripe list-customers --limit=10`}
              />
              <OutputCard
                icon={<Globe size={16} />}
                title="HTTP API"
                snippet={`curl -X POST https://floom.dev/api/run \\\n  -d '{"app":"stripe","action":"list-customers"}'`}
              />
              <OutputCard
                icon={<MessageSquare size={16} />}
                title="Chat UI"
                linkTo="/apps"
                linkLabel="Browse live apps"
              />
            </div>
          </div>
        </div>
      </section>

      {/* ── Try it live ─────────────────────────────────────────── */}
      <section
        style={{ borderBottom: '1px solid var(--line)', padding: '64px 24px' }}
        data-testid="hero-demo"
      >
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <p className="label-mono" style={{ marginBottom: 8 }}>Try it live</p>
          <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
            Run FlyFast in one click.
          </h2>
          <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 32, maxWidth: 520 }}>
            No signup. No config. Just describe the flight you want.
          </p>

          <FloomApp
            app={demoApp}
            standalone={true}
            showSidebar={true}
            initialInputs={{ prompt: 'Cheap flight from Berlin to Lisbon first week of May' }}
          />
        </div>
      </section>

      {/* ── Full plumbing stack ───────────────────────────────────── */}
      <section style={{ borderBottom: '1px solid var(--line)', padding: '64px 24px' }}>
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
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
              <PlumbingCell key={item.name} name={item.name} desc={item.desc} live Icon={item.Icon} />
            ))}
            {PLUMBING_SOON.map((item) => (
              <PlumbingCell key={item.name} name={item.name} desc={item.desc} live={false} Icon={item.Icon} />
            ))}
          </div>
        </div>
      </section>

      {/* ── Self-host (2-col) ────────────────────────────────────── */}
      <section
        data-testid="self-host-section"
        style={{ borderBottom: '1px solid var(--line)', padding: '64px 24px' }}
      >
        <div style={{ maxWidth: 1200, margin: '0 auto' }}>
          <p className="label-mono" style={{ marginBottom: 8 }}>Open source</p>
          <h2 style={{ fontSize: 28, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
            Self-host anywhere.
          </h2>
          <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 36, maxWidth: 520 }}>
            Same runtime on cloud and self-host. Your domain, your auth, your data. MIT licensed.
          </p>

          <div className="selfhost-2col">
            {/* Left: Docker */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 5, color: 'var(--muted)', fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Docker</span>
              </div>
              <div style={{ position: 'relative' }}>
                <pre style={{ background: 'var(--terminal-bg, #0e0e0c)', color: 'var(--terminal-ink, #d4d4c8)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '18px 16px', borderRadius: 10, overflowX: 'auto', lineHeight: 1.7, margin: 0 }}>
                  {DOCKER_CMD}
                </pre>
                <button
                  type="button"
                  onClick={() => copy(DOCKER_CMD, setDockerCopied)}
                  style={{
                    position: 'absolute', top: 10, right: 10,
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
            </div>

            {/* Right: npm */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 11, fontWeight: 700, padding: '3px 8px', background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 5, color: 'var(--muted)', fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.06em' }}>npm</span>
              </div>
              <div style={{ position: 'relative' }}>
                <pre style={{ background: 'var(--terminal-bg, #0e0e0c)', color: 'var(--terminal-ink, #d4d4c8)', fontFamily: 'JetBrains Mono, monospace', fontSize: 12, padding: '18px 16px', borderRadius: 10, overflowX: 'auto', lineHeight: 1.7, margin: 0 }}>
                  {NPM_CMD}{'\n\n'}{NPM_IMPORT}
                </pre>
                <button
                  type="button"
                  onClick={() => copy(NPM_CMD, setNpmCopied)}
                  style={{
                    position: 'absolute', top: 10, right: 10,
                    fontSize: 11, padding: '3px 10px',
                    background: 'rgba(255,255,255,0.1)',
                    border: '1px solid rgba(255,255,255,0.15)',
                    borderRadius: 6,
                    color: npmCopied ? '#7bffc0' : 'rgba(255,255,255,0.6)',
                    cursor: 'pointer', fontFamily: 'inherit', transition: 'color 0.15s',
                  }}
                >
                  {npmCopied ? 'Copied!' : 'Copy'}
                </button>
              </div>
            </div>
          </div>

          <p style={{ marginTop: 20, fontSize: 13, color: 'var(--muted)', maxWidth: 560 }}>
            Floom.dev is the hosted flagship. Same runtime, your domain.
          </p>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 20 }}>
            <a
              href="https://github.com/floomhq/floom-monorepo"
              target="_blank"
              rel="noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '10px 20px', background: 'var(--card)', border: '1px solid var(--line)', color: 'var(--ink)', borderRadius: 8, fontSize: 14, fontWeight: 500, textDecoration: 'none' }}
            >
              <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                <use href="#icon-github" />
              </svg>
              View the source
            </a>
            <Link
              to="/protocol"
              style={{ display: 'inline-flex', alignItems: 'center', padding: '10px 20px', background: 'none', color: 'var(--muted)', borderRadius: 8, fontSize: 14, fontWeight: 500, textDecoration: 'none' }}
            >
              Read the protocol
            </Link>
          </div>
        </div>
      </section>

      {/* ── Footer ───────────────────────────────────────────────── */}
      <footer
        style={{
          maxWidth: 1200,
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
          <Link to="/protocol" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>protocol</Link>
          <a href="https://github.com/floomhq/floom-monorepo" target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>github</a>
        </nav>
      </footer>
    </div>
  );
}

// ── PlumbingCell ───────────────────────────────────────────────────────────

function PlumbingCell({
  name,
  desc,
  live,
  Icon,
}: {
  name: string;
  desc: string;
  live: boolean;
  Icon: React.ElementType<{ size?: number | string; className?: string }>;
}) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '14px 16px',
        position: 'relative',
        opacity: live ? 1 : 0.7,
        display: 'flex',
        gap: 12,
        alignItems: 'flex-start',
      }}
    >
      <div style={{ color: live ? 'var(--accent)' : 'var(--muted)', flexShrink: 0, paddingTop: 1 }}>
        <Icon size={18} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
          <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
            {name}
          </p>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              padding: '2px 6px',
              borderRadius: 4,
              background: live ? 'rgba(99,102,241,0.12)' : 'var(--bg)',
              color: live ? '#6366f1' : 'var(--muted)',
              border: live ? '1px solid rgba(99,102,241,0.25)' : '1px solid var(--line)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              flexShrink: 0,
            }}
          >
            {live ? 'Live' : 'Soon'}
          </span>
        </div>
        <p style={{ margin: 0, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{desc}</p>
      </div>
    </div>
  );
}

// ── OutputCard ─────────────────────────────────────────────────────────────

function OutputCard({
  icon,
  title,
  snippet,
  linkTo,
  linkLabel,
}: {
  icon: React.ReactNode;
  title: string;
  snippet?: string;
  linkTo?: string;
  linkLabel?: string;
}) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 10,
        padding: '14px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: snippet || linkTo ? 10 : 0 }}>
        <span style={{ color: 'var(--accent)' }}>{icon}</span>
        <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>{title}</span>
      </div>
      {snippet && (
        <pre
          style={{
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 6,
            padding: '8px 10px',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 11,
            color: 'var(--muted)',
            margin: 0,
            overflowX: 'auto',
            lineHeight: 1.6,
            whiteSpace: 'pre',
          }}
        >
          {snippet}
        </pre>
      )}
      {linkTo && (
        <Link
          to={linkTo}
          style={{ fontSize: 13, color: 'var(--accent)', textDecoration: 'none', fontWeight: 500 }}
        >
          {linkLabel} →
        </Link>
      )}
    </div>
  );
}
