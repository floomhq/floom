import { PageShell } from '../components/PageShell';

type IaRow = {
  url: string;
  name: string;
  file: string;
};

const publicRows: IaRow[] = [
  { url: '/', name: 'Landing', file: 'landing' },
  { url: '/apps', name: 'Apps directory', file: 'apps' },
  { url: '/p/:slug', name: 'App page', file: 'app-page' },
  { url: '/r/:id', name: 'Public run permalink', file: 'r-perma' },
  { url: '/pricing', name: 'Pricing', file: 'pricing' },
  { url: '/docs', name: 'Docs landing', file: 'docs' },
  { url: '/docs/:slug', name: 'Docs detail', file: 'detail' },
  { url: '/install-in-claude', name: 'Install guide', file: 'claude' },
  { url: '/login', name: 'Login', file: 'login' },
  { url: '/signup', name: 'Signup', file: 'signup' },
];

const runRows: IaRow[] = [
  { url: '/run', name: 'Workspace Run', file: 'run' },
  { url: '/run/apps', name: 'Apps + tags + filter', file: 'apps' },
  { url: '/run/apps/:slug/run', name: 'Run an installed app', file: 'app-run' },
  { url: '/run/apps/:slug/triggers', name: 'Per-user triggers', file: 'triggers' },
  { url: '/run/runs', name: 'Run history', file: 'runs' },
  { url: '/run/runs/:id', name: 'Run detail', file: 'detail' },
  { url: '/settings/byok-keys', name: 'BYOK keys', file: 'byok' },
  { url: '/settings/agent-tokens', name: 'Agent tokens', file: 'tokens' },
  { url: '/account/settings', name: 'Account settings', file: 'settings' },
];

const studioRows: IaRow[] = [
  { url: '/studio', name: 'Studio home', file: 'studio' },
  { url: '/studio/build', name: 'Publish flow', file: 'build' },
  { url: '/studio/:slug', name: 'App overview', file: 'overview' },
  { url: '/studio/:slug/runs', name: 'Runs tab', file: 'runs' },
  { url: '/studio/:slug/access', name: 'Access / visibility', file: 'access' },
  { url: '/studio/:slug/secrets', name: 'App creator secrets', file: 'creator-secrets' },
  { url: '/studio/:slug/renderer', name: 'Source / renderer', file: 'source' },
  { url: '/studio/:slug/analytics', name: 'Analytics', file: 'analytics' },
  { url: '/studio/:slug/feedback', name: 'Feedback', file: 'feedback' },
];

export function IaPage() {
  return (
    <PageShell
      title="Information architecture · Floom"
      description="Floom information architecture: public, Workspace Run, and Studio surfaces."
      contentStyle={{ maxWidth: 1180 }}
    >
      <main style={pageStyle}>
        <section style={heroStyle}>
          <div style={eyebrowStyle}>v24 canon</div>
          <h1 style={h1Style}>Information architecture</h1>
          <p style={leadStyle}>
            Three surfaces. Public surfaces invite. Workspace Run shows what people use.
            Studio shows what creators ship.
          </p>
        </section>

        <section aria-label="Sitemap" style={gridStyle}>
          <IaColumn title="Public" lead="Anonymous discovery and run. No auth required." rows={publicRows} />
          <IaColumn title="Workspace Run" lead="Authenticated consumer home for runnable apps, runs, and workspace runtime settings." rows={runRows} />
          <IaColumn title="Studio" lead="Creator workspace for publishing, review, visibility, analytics, and app-level configuration." rows={studioRows} />
        </section>

        <InfoBlock title="Navigation chrome rules">
          <p style={bodyStyle}>
            Anonymous top navigation: <strong>Apps · Docs · Pricing</strong>. Authenticated
            top navigation: <strong>Run · Studio</strong>. Discovery links move into the
            account menu after sign-in.
          </p>
          <p style={bodyStyle}>
            Studio uses a left rail with workspace identity, publish CTA, app list, and
            workspace settings. Flat pages keep only the TopBar.
          </p>
        </InfoBlock>

        <InfoBlock title="URL structure">
          <ul style={listStyle}>
            <li><code>/run</code> is the Workspace Run home for apps and run artifacts.</li>
            <li><code>/studio</code> is the creator surface for published apps.</li>
            <li><code>/p/:slug</code> is the public app showcase and run interface.</li>
            <li><code>/r/:id</code> is the shareable public run permalink.</li>
            <li><code>/apps</code> is the public catalog.</li>
          </ul>
        </InfoBlock>

        <InfoBlock title="Cross-page journeys">
          <div style={journeyGridStyle}>
            <Journey
              label="Discover → Run → Save"
              steps={['Open /apps', 'Run from /p/:slug', 'Save or share /r/:id', 'See it again in /run']}
            />
            <Journey
              label="Build → Publish → Observe"
              steps={['Open /studio/build', 'Publish from repo or spec', 'Review /studio/:slug', 'Watch runs and feedback']}
            />
          </div>
        </InfoBlock>
      </main>
    </PageShell>
  );
}

function IaColumn({ title, lead, rows }: { title: string; lead: string; rows: IaRow[] }) {
  return (
    <article style={columnStyle}>
      <h2 style={columnTitleStyle}>{title}</h2>
      <p style={columnLeadStyle}>{lead}</p>
      <div>
        {rows.map((row) => (
          <div key={`${row.url}-${row.name}`} style={rowStyle}>
            <code style={urlStyle}>{row.url}</code>
            <span style={nameStyle}>{row.name}</span>
            <span style={fileStyle}>{row.file}</span>
          </div>
        ))}
      </div>
    </article>
  );
}

function InfoBlock({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={blockStyle}>
      <h2 style={blockTitleStyle}>{title}</h2>
      {children}
    </section>
  );
}

function Journey({ label, steps }: { label: string; steps: string[] }) {
  return (
    <div>
      <div style={journeyLabelStyle}>{label}</div>
      <ol style={orderedStyle}>
        {steps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
    </div>
  );
}

const pageStyle: React.CSSProperties = { display: 'grid', gap: 26 };
const heroStyle: React.CSSProperties = { padding: '38px 0 6px' };
const eyebrowStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 10,
};
const h1Style: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 46,
  fontWeight: 850,
  letterSpacing: 0,
  lineHeight: 1.05,
  margin: 0,
  color: 'var(--ink)',
};
const leadStyle: React.CSSProperties = {
  maxWidth: 760,
  fontSize: 15,
  lineHeight: 1.65,
  color: 'var(--muted)',
  margin: '14px 0 0',
};
const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))',
  gap: 16,
};
const columnStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  padding: '20px 22px',
};
const columnTitleStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 850,
  letterSpacing: 0,
  margin: '0 0 4px',
  color: 'var(--ink)',
};
const columnLeadStyle: React.CSSProperties = {
  fontSize: 12.5,
  lineHeight: 1.5,
  color: 'var(--muted)',
  margin: '0 0 14px',
};
const rowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(110px, auto) 1fr auto',
  gap: 10,
  alignItems: 'center',
  padding: '9px 0',
  borderTop: '1px solid var(--line)',
  fontSize: 13,
};
const urlStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11.5,
  color: 'var(--muted)',
};
const nameStyle: React.CSSProperties = { fontWeight: 600, color: 'var(--ink)' };
const fileStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 10.5,
  color: 'var(--accent)',
  border: '1px solid rgba(4,120,87,0.18)',
  background: 'rgba(4,120,87,0.08)',
  padding: '2px 7px',
  borderRadius: 5,
};
const blockStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  padding: '20px 22px',
};
const blockTitleStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 850,
  letterSpacing: 0,
  color: 'var(--ink)',
  margin: '0 0 12px',
};
const bodyStyle: React.CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.65,
  color: 'var(--ink)',
  margin: '0 0 8px',
};
const listStyle: React.CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.75,
  color: 'var(--ink)',
  margin: 0,
  paddingLeft: 20,
};
const journeyGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
  gap: 18,
};
const journeyLabelStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 800,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--accent)',
  marginBottom: 8,
};
const orderedStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.75,
  color: 'var(--ink)',
  margin: 0,
  paddingLeft: 20,
};
