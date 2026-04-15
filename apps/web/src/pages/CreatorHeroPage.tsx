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

// Inline demo stub. Hook Stats is a fast, no-signup productivity app that
// matches the locked scope (internal tooling + weekend-vibe-coded apps).
// FlyFast was blocked in W2.4c, so we run Hook Stats until the fast-apps
// agent lands a faster option.
const HOOK_STATS_STUB: AppDetail = {
  slug: 'hook-stats',
  name: 'Hook Stats',
  description: 'Analyze your Claude Code bash command log. Top commands, git stats, per-day activity.',
  category: 'productivity',
  author: 'buildingopen',
  icon: null,
  actions: ['analyze'],
  runtime: 'node',
  created_at: '',
  manifest: {
    name: 'Hook Stats',
    description: 'Analyze your Claude Code bash command log.',
    actions: {
      analyze: {
        label: 'Analyze Log',
        description: 'Paste a bash-commands.log and get stats back.',
        inputs: [
          {
            name: 'log_content',
            label: 'bash-commands.log content',
            type: 'textarea',
            required: true,
            placeholder: '[2026-04-15T10:00:00Z] git status\n[2026-04-15T10:00:05Z] pnpm test',
          },
        ],
        outputs: [
          { name: 'report', label: 'Report', type: 'markdown' },
        ],
      },
    },
    runtime: 'node',
    python_dependencies: [],
    node_dependencies: {},
    secrets_needed: [],
    manifest_version: '2.0',
  },
};

const SAMPLE_LOG = `[2026-04-15T10:00:00Z] git status
[2026-04-15T10:00:05Z] git diff --stat
[2026-04-15T10:01:00Z] pnpm build
[2026-04-15T10:02:00Z] pnpm test
[2026-04-15T10:05:00Z] git add -p
[2026-04-15T10:06:00Z] git commit -m "fix"
[2026-04-15T10:07:00Z] git push`;

const DOCKER_CMD = `docker run -p 3051:3051 \\
  ghcr.io/floomhq/floom-monorepo:latest`;

const FOUR_THINGS = [
  { Icon: Server, label: 'MCP server', desc: 'Auto-generated from every OpenAPI operation. Drop into Claude, Cursor, Windsurf.' },
  { Icon: Globe, label: 'HTTP API', desc: 'Pass-through proxy with auth, rate limits, secrets injection.' },
  { Icon: Terminal, label: 'CLI', desc: '@floom/cli. Every action is a command. Pipe inputs, pipe outputs.' },
  { Icon: LayoutTemplate, label: 'Web', desc: 'Hosted form and output renderer at /p/:slug. Share a link, no SDK.' },
];

export function CreatorHeroPage() {
  const [demoApp, setDemoApp] = useState<AppDetail>(HOOK_STATS_STUB);
  const [dockerCopied, setDockerCopied] = useState(false);

  useEffect(() => {
    document.title = 'Floom · Production layer for vibe-coded AI apps';
    getApp('hook-stats').then((a) => setDemoApp(a)).catch(() => {});
  }, []);

  const copyDocker = () => {
    try { navigator.clipboard.writeText(DOCKER_CMD).catch(() => {}); } catch { /* ignore */ }
    setDockerCopied(true);
    setTimeout(() => setDockerCopied(false), 2000);
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
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <h1
            className="headline"
            style={{ marginBottom: 20, textWrap: 'balance' as unknown as 'balance' }}
          >
            Vibe-coding speed.<br />Production-grade safety.
          </h1>
          <p style={{ fontSize: 18, color: 'var(--muted)', margin: '0 auto 36px', maxWidth: 540, lineHeight: 1.6 }}>
            The production layer for AI apps that do real work.
          </p>

          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link
              to="/apps"
              className="btn-primary"
              data-testid="hero-cta-try"
              style={{ padding: '12px 26px', fontSize: 15, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
            >
              Try an app
            </Link>
            <Link
              to="/build"
              className="btn-primary"
              data-testid="hero-cta-ship"
              style={{ padding: '12px 26px', fontSize: 15, textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
            >
              Ship an app
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
            Run Hook Stats. No signup.
          </h2>
          <p style={{ fontSize: 14, color: 'var(--muted)', textAlign: 'center', maxWidth: 480, margin: '0 auto 32px', lineHeight: 1.6 }}>
            Paste your Claude Code bash log, click Run, get a breakdown. The
            same Floom layer (auth, logs, access) wraps every app on preview.
          </p>
          <FloomApp
            app={demoApp}
            standalone={true}
            showSidebar={false}
            initialInputs={{ log_content: SAMPLE_LOG }}
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
              gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
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
          <p className="label-mono" style={{ marginBottom: 8 }}>Open core</p>
          <h2 style={{ fontSize: 24, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
            Self-host. One command. Your data.
          </h2>
          <p style={{ fontSize: 15, color: 'var(--muted)', marginBottom: 28, maxWidth: 520, lineHeight: 1.6 }}>
            Docker and npx ship the whole engine: four surfaces, auth, access
            control, activity, memory, schedules, webhooks, versions. Free
            forever.
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

      {/* Footer */}
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
      <FeedbackButton />
    </div>
  );
}
