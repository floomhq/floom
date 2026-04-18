/**
 * LayersGrid — "What's in the box."
 *
 * Six real shipped layers pulled from docs/ROADMAP.md and
 * memory/project_floom_layers.md. Each card gets a title, a one-sentence
 * description, and a tiny code-or-diagram artifact that proves it's real.
 *
 * No fake SaaS screenshots, no hero illustrations. Monospace snippets do
 * the talking.
 */

interface Layer {
  name: string;
  desc: string;
  /** Compact proof artifact rendered inside the card. */
  artifact: React.ReactNode;
}

const LAYERS: Layer[] = [
  {
    name: 'Ingest',
    desc: 'OpenAPI spec or GitHub repo in. Typed manifest out. No hand-writing tool schemas.',
    artifact: (
      <CodeSnippet>
        <span style={{ color: '#64748b' }}>$</span> floom publish{' '}
        <span style={{ color: '#6ee7b7' }}>openapi.json</span>
        {'\n'}
        <span style={{ color: '#64748b' }}>
          → 7 operations · manifest v1 · ready
        </span>
      </CodeSnippet>
    ),
  },
  {
    name: 'Runtime',
    desc: 'Every app runs in its own Docker sandbox. Proxied or native. Zero shared state.',
    artifact: (
      <CodeSnippet>
        <span style={{ color: '#64748b' }}>#</span> isolated, per-request
        {'\n'}docker run{' '}
        <span style={{ color: '#6ee7b7' }}>floom/runner:app-xxx</span>
      </CodeSnippet>
    ),
  },
  {
    name: 'Secrets',
    desc: 'Per-user vault with creator overrides. Keys never touch the client, never log in plain text.',
    artifact: (
      <CodeSnippet>
        <span style={{ color: '#64748b' }}>$</span> floom secrets set{' '}
        <span style={{ color: '#6ee7b7' }}>OPENAI_API_KEY</span>
        {'\n'}
        <span style={{ color: '#64748b' }}>→ stored (user scope)</span>
      </CodeSnippet>
    ),
  },
  {
    name: 'Runs',
    desc: 'Every execution is logged, addressable, and shareable. Replay any run, any time.',
    artifact: (
      <CodeSnippet>
        GET /api/runs/<span style={{ color: '#6ee7b7' }}>r_Q3k...9p</span>
        {'\n'}200 · status:ok · dur:1.8s
      </CodeSnippet>
    ),
  },
  {
    name: 'Surfaces',
    desc: 'MCP tool, HTTP API, CLI, chat UI, shareable web form. Five clients, one backend.',
    artifact: (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {['MCP', 'HTTP', 'CLI', 'Chat', 'Share'].map((s) => (
          <span
            key={s}
            style={{
              fontFamily: "'JetBrains Mono', ui-monospace, monospace",
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--accent)',
              background: '#ecfdf5',
              border: '1px solid #d1fae5',
              padding: '4px 9px',
              borderRadius: 999,
              letterSpacing: '0.02em',
            }}
          >
            {s}
          </span>
        ))}
      </div>
    ),
  },
  {
    name: 'Renderer',
    desc: 'Upload a custom TSX renderer. Sandboxed at build and runtime. Your brand on every run page.',
    artifact: (
      <CodeSnippet>
        <span style={{ color: '#64748b' }}>//</span> renderer.tsx
        {'\n'}export default{' '}
        <span style={{ color: '#6ee7b7' }}>{'({ output }) =>'}</span>{' '}
        {'<Card />'}
      </CodeSnippet>
    ),
  },
];

function CodeSnippet({ children }: { children: React.ReactNode }) {
  return (
    <pre
      style={{
        margin: 0,
        padding: '12px 14px',
        background: '#0b1220',
        color: '#e2e8f0',
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 12,
        lineHeight: 1.55,
        borderRadius: 8,
        overflowX: 'auto',
        whiteSpace: 'pre',
        maxWidth: '100%',
        minWidth: 0,
      }}
    >
      {children}
    </pre>
  );
}

export function LayersGrid() {
  return (
    <section
      data-testid="home-layers"
      data-section="layers"
      style={{
        background: 'var(--card)',
        borderTop: '1px solid var(--line)',
        borderBottom: '1px solid var(--line)',
        padding: '96px 24px',
      }}
    >
      <div style={{ maxWidth: 1040, margin: '0 auto' }}>
        <header style={{ textAlign: 'center', marginBottom: 48 }}>
          <h2
            style={{
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontWeight: 400,
              fontSize: 44,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
              margin: '0 0 14px',
            }}
          >
            What&apos;s in the box.
          </h2>
          <p
            style={{
              fontSize: 17,
              color: 'var(--muted)',
              lineHeight: 1.55,
              maxWidth: 520,
              margin: '0 auto',
            }}
          >
            Six production layers ship today. Every one of them is open
            source and self-hostable in a single container.
          </p>
        </header>

        <div
          className="layers-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 16,
          }}
        >
          {LAYERS.map((layer) => (
            <article
              key={layer.name}
              data-testid={`layer-${layer.name.toLowerCase()}`}
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--line)',
                borderRadius: 14,
                padding: 22,
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                minWidth: 0,
              }}
            >
              <div>
                <h3
                  style={{
                    fontSize: 18,
                    fontWeight: 700,
                    color: 'var(--ink)',
                    margin: '0 0 6px',
                    letterSpacing: '-0.01em',
                  }}
                >
                  {layer.name}
                </h3>
                <p
                  style={{
                    fontSize: 14,
                    color: 'var(--muted)',
                    lineHeight: 1.55,
                    margin: 0,
                  }}
                >
                  {layer.desc}
                </p>
              </div>
              <div style={{ marginTop: 'auto' }}>{layer.artifact}</div>
            </article>
          ))}
        </div>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .layers-grid { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </section>
  );
}
