import { Link } from 'react-router-dom';
import { Fragment } from 'react';
import { PageShell } from '../components/PageShell';

const matrix = [
  {
    path: 'Anonymous runs',
    web: 'Run public apps in /p/:slug',
    mcp: 'Read public app metadata',
    rest: 'POST public run endpoints',
    cli: 'Install first',
  },
  {
    path: 'Anonymous from Claude',
    web: 'Install guide',
    mcp: 'Public catalog only',
    rest: 'No private workspace access',
    cli: 'Create Agent token first',
  },
  {
    path: 'Workspace from agent',
    web: 'Agent tokens page',
    mcp: 'Run workspace apps',
    rest: 'Bearer Agent token',
    cli: 'floom auth login',
  },
  {
    path: 'Creator publishes',
    web: 'Studio build flow',
    mcp: 'Admin ingest tools',
    rest: 'Hub ingest routes',
    cli: 'floom deploy',
  },
] as const;

const pillars = [
  {
    title: 'One protocol',
    body: 'floom.yaml declares actions, inputs, outputs, runtime, and sharing. The same spec drives web, MCP, REST, and CLI.',
  },
  {
    title: 'One auth primitive',
    body: 'Agent tokens carry workspace scope for headless clients. Browser sessions keep account settings separate from runtime access.',
  },
  {
    title: 'One sharing model',
    body: 'Private, link, invited, and public visibility states keep publishing explicit and reviewable.',
  },
] as const;

const lifecycle = [
  ['1', 'Spec', 'Repo, OpenAPI URL, or floom.yaml enters Studio.'],
  ['2', 'Detect', 'Floom resolves actions, input fields, auth hints, and runtime shape.'],
  ['3', 'Publish', 'The app lands private by default in the creator workspace.'],
  ['4', 'Run handler', 'Sandboxed runtime gets workspace BYOK keys only at run time.'],
  ['5', 'Output renderer', 'Structured outputs render consistently across browser and links.'],
  ['6', 'Observe', 'Studio exposes runs, feedback, visibility, and app creator secrets.'],
] as const;

export function ArchitecturePage() {
  return (
    <PageShell
      title="Architecture · Floom"
      description="How Floom maps web, MCP, REST, and CLI surfaces onto one protocol and one runtime."
      contentStyle={{ maxWidth: 1120 }}
    >
      <main style={pageStyle}>
        <section style={heroStyle}>
          <div style={eyebrowStyle}>How Floom works</div>
          <h1 style={h1Style}>Four user paths × four surfaces.</h1>
          <p style={leadStyle}>Pick a row. Pick a column. Floom does what the cell says.</p>
        </section>

        <section aria-label="Architecture matrix" style={matrixStyle}>
          <div style={matrixHeadStyle}>User path</div>
          <div style={matrixHeadStyle}>Web</div>
          <div style={matrixHeadStyle}>MCP</div>
          <div style={matrixHeadStyle}>REST</div>
          <div style={matrixHeadStyle}>CLI</div>
          {matrix.map((row) => (
            <Fragment key={row.path}>
              <div style={pathCellStyle}>{row.path}</div>
              <MatrixCell primary>{row.web}</MatrixCell>
              <MatrixCell>{row.mcp}</MatrixCell>
              <MatrixCell>{row.rest}</MatrixCell>
              <MatrixCell>{row.cli}</MatrixCell>
            </Fragment>
          ))}
        </section>

        <section style={pillarGridStyle}>
          {pillars.map((pillar) => (
            <article key={pillar.title} style={pillarStyle}>
              <h2 style={pillarTitleStyle}>{pillar.title}</h2>
              <p style={pillarBodyStyle}>{pillar.body}</p>
            </article>
          ))}
        </section>

        <section style={flowStyle}>
          <div>
            <h2 style={sectionTitleStyle}>Lifecycle</h2>
            <div style={stepStackStyle}>
              {lifecycle.map(([num, title, body]) => (
                <div key={num} style={stepStyle}>
                  <span style={numStyle}>{num}</span>
                  <div>
                    <strong>{title}</strong>
                    <p style={stepBodyStyle}>{body}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div style={codePanelStyle}>
            <div style={codeTitleStyle}>Same handler, four envelopes</div>
            <pre style={codeStyle}>{`handler.score({
  input,
  byok: runtime.env.GEMINI_API_KEY,
  auth: workspace.agentToken,
});

web.form()
mcp.tool()
rest.post()
cli.run()`}</pre>
          </div>
        </section>

        <section style={ctaStyle}>
          <div>
            <h2 style={sectionTitleStyle}>Build on the map.</h2>
            <p style={pillarBodyStyle}>Start in Studio, mint Agent tokens, then call the same app from any surface.</p>
          </div>
          <div style={ctaLinksStyle}>
            <Link to="/studio/build" style={primaryLinkStyle}>Publish an app</Link>
            <Link to="/settings/agent-tokens" style={secondaryLinkStyle}>Agent tokens</Link>
          </div>
        </section>
      </main>
    </PageShell>
  );
}

function MatrixCell({ children, primary = false }: { children: React.ReactNode; primary?: boolean }) {
  return <div style={primary ? primaryCellStyle : cellStyle}>{children}</div>;
}

const pageStyle: React.CSSProperties = { display: 'grid', gap: 28 };
const heroStyle: React.CSSProperties = { padding: '42px 0 2px', textAlign: 'center' };
const eyebrowStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  color: 'var(--accent)',
  marginBottom: 12,
};
const h1Style: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 48,
  fontWeight: 850,
  letterSpacing: 0,
  lineHeight: 1.05,
  color: 'var(--ink)',
  margin: 0,
};
const leadStyle: React.CSSProperties = {
  color: 'var(--muted)',
  fontSize: 16,
  lineHeight: 1.55,
  margin: '12px auto 0',
  maxWidth: 560,
};
const matrixStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1.15fr repeat(4, minmax(120px, 1fr))',
  border: '1px solid var(--line)',
  borderRadius: 8,
  overflow: 'hidden',
  background: 'var(--card)',
};
const matrixHeadStyle: React.CSSProperties = {
  padding: '12px 14px',
  borderRight: '1px solid var(--line)',
  borderBottom: '1px solid var(--line)',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 800,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  color: 'var(--muted)',
};
const pathCellStyle: React.CSSProperties = {
  padding: '14px',
  borderRight: '1px solid var(--line)',
  borderBottom: '1px solid var(--line)',
  fontSize: 13,
  fontWeight: 800,
  color: 'var(--ink)',
};
const cellStyle: React.CSSProperties = {
  padding: '14px',
  borderRight: '1px solid var(--line)',
  borderBottom: '1px solid var(--line)',
  fontSize: 12.5,
  lineHeight: 1.45,
  color: 'var(--muted)',
};
const primaryCellStyle: React.CSSProperties = {
  ...cellStyle,
  background: 'rgba(4,120,87,0.08)',
  color: 'var(--ink)',
  fontWeight: 700,
};
const pillarGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))',
  gap: 14,
};
const pillarStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  padding: 20,
};
const pillarTitleStyle: React.CSSProperties = {
  fontSize: 18,
  fontWeight: 850,
  color: 'var(--ink)',
  margin: '0 0 8px',
};
const pillarBodyStyle: React.CSSProperties = {
  fontSize: 13.5,
  lineHeight: 1.6,
  color: 'var(--muted)',
  margin: 0,
};
const flowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) minmax(300px, 0.9fr)',
  gap: 18,
  alignItems: 'stretch',
};
const sectionTitleStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 850,
  color: 'var(--ink)',
  margin: '0 0 14px',
};
const stepStackStyle: React.CSSProperties = { display: 'grid', gap: 10 };
const stepStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '40px 1fr',
  gap: 12,
  alignItems: 'start',
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  padding: 14,
};
const numStyle: React.CSSProperties = {
  width: 32,
  height: 32,
  borderRadius: 8,
  background: 'var(--accent)',
  color: '#fff',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12,
  fontWeight: 800,
};
const stepBodyStyle: React.CSSProperties = {
  fontSize: 12.5,
  color: 'var(--muted)',
  lineHeight: 1.5,
  margin: '4px 0 0',
};
const codePanelStyle: React.CSSProperties = {
  border: '1px solid #2a2925',
  borderRadius: 8,
  background: '#1b1a17',
  color: '#e7e3d7',
  padding: 18,
};
const codeTitleStyle: React.CSSProperties = {
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 11,
  fontWeight: 800,
  color: '#9ca3af',
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  marginBottom: 12,
};
const codeStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'JetBrains Mono, monospace',
  fontSize: 12.5,
  lineHeight: 1.7,
  whiteSpace: 'pre-wrap',
};
const ctaStyle: React.CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 8,
  background: 'var(--card)',
  padding: 22,
  display: 'flex',
  justifyContent: 'space-between',
  gap: 18,
  alignItems: 'center',
  flexWrap: 'wrap',
};
const ctaLinksStyle: React.CSSProperties = { display: 'flex', gap: 10, flexWrap: 'wrap' };
const primaryLinkStyle: React.CSSProperties = {
  display: 'inline-flex',
  border: '1px solid var(--ink)',
  background: 'var(--ink)',
  color: '#fff',
  borderRadius: 8,
  padding: '10px 14px',
  textDecoration: 'none',
  fontSize: 13,
  fontWeight: 800,
};
const secondaryLinkStyle: React.CSSProperties = {
  ...primaryLinkStyle,
  background: 'var(--bg)',
  color: 'var(--ink)',
  border: '1px solid var(--line)',
};
