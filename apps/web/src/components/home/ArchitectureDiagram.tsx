/**
 * ArchitectureDiagram — "One spec. Five surfaces."
 *
 * A clean, typographic SVG that shows how a single OpenAPI spec /
 * GitHub repo flows through the Floom runtime and fans out into five
 * surfaces. Each surface tile is a real anchor to the matching /docs
 * section, so the diagram doubles as navigation.
 *
 * No gradients, no glow, no decorative art. Slate borders for the
 * spec + surfaces, brand emerald for the Floom node. Renders crisp
 * at any viewport because it's inline SVG with text-based labels.
 */
import { Link } from 'react-router-dom';

interface Surface {
  label: string;
  hint: string;
  href: string;
}

const SURFACES: Surface[] = [
  { label: 'MCP', hint: 'tool', href: '/docs#mcp' },
  { label: 'HTTP', hint: 'API', href: '/docs#http' },
  { label: 'CLI', hint: '', href: '/docs#cli' },
  { label: 'Chat', hint: 'UI', href: '/docs#chat' },
  { label: 'Share', hint: 'URL', href: '/docs#permalink' },
];

export function ArchitectureDiagram() {
  return (
    <section
      data-testid="home-architecture"
      data-section="architecture"
      style={{
        background: 'var(--card)',
        borderTop: '1px solid var(--line)',
        borderBottom: '1px solid var(--line)',
        padding: '96px 24px',
      }}
    >
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <header style={{ textAlign: 'center', marginBottom: 56 }}>
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
            One spec. Five surfaces.
          </h2>
          <p
            style={{
              fontSize: 17,
              color: 'var(--muted)',
              lineHeight: 1.55,
              maxWidth: 560,
              margin: '0 auto',
            }}
          >
            Ship an OpenAPI spec or a GitHub repo. Floom exposes it as a
            Claude-callable MCP tool, an HTTP API, a CLI, a chat surface,
            and a shareable run page. One runtime. One source of truth.
          </p>
        </header>

        <div className="arch-wrap">
          {/* Spec pill at the top */}
          <div className="arch-node arch-spec" aria-label="Input: OpenAPI spec or GitHub repo">
            <span
              style={{
                fontSize: 11,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              Input
            </span>
            <span style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 15 }}>
              Your OpenAPI spec <span style={{ color: 'var(--muted)' }}>/</span> GitHub repo
            </span>
          </div>

          <Connector />

          {/* Floom runtime node — brand color */}
          <div className="arch-node arch-runtime" aria-label="Floom runtime">
            <span
              style={{
                fontSize: 11,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                color: 'rgba(255,255,255,0.7)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              Runtime
            </span>
            <span style={{ fontWeight: 700, color: '#fff', fontSize: 16 }}>Floom</span>
            <span
              style={{
                marginTop: 4,
                fontSize: 12,
                color: 'rgba(255,255,255,0.8)',
                lineHeight: 1.4,
                maxWidth: 240,
                textAlign: 'center',
              }}
            >
              Ingest + execute + render, with secrets, rate limits, and logs.
            </span>
          </div>

          <Connector />

          {/* Fan-out: five surface tiles */}
          <div
            className="arch-surfaces"
            role="list"
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${SURFACES.length}, minmax(0, 1fr))`,
              gap: 12,
              width: '100%',
              maxWidth: 640,
            }}
          >
            {SURFACES.map((s) => (
              <Link
                key={s.label}
                to={s.href}
                role="listitem"
                className="arch-surface"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  padding: '18px 10px',
                  background: 'var(--bg)',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  color: 'var(--ink)',
                  textDecoration: 'none',
                  minHeight: 78,
                  transition: 'border-color 140ms ease, transform 140ms ease',
                }}
                onMouseEnter={(e) => {
                  const el = e.currentTarget as HTMLAnchorElement;
                  el.style.borderColor = 'var(--accent)';
                  el.style.transform = 'translateY(-1px)';
                }}
                onMouseLeave={(e) => {
                  const el = e.currentTarget as HTMLAnchorElement;
                  el.style.borderColor = 'var(--line)';
                  el.style.transform = 'translateY(0)';
                }}
              >
                <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--ink)' }}>
                  {s.label}
                </span>
                {s.hint && (
                  <span
                    style={{
                      marginTop: 2,
                      fontSize: 11,
                      fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                      color: 'var(--muted)',
                      textTransform: 'lowercase',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {s.hint}
                  </span>
                )}
              </Link>
            ))}
          </div>
        </div>
      </div>

      <style>{`
        .arch-wrap {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0;
        }
        .arch-node {
          display: inline-flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          padding: 14px 24px;
          border-radius: 14px;
          min-width: 260px;
          max-width: min(440px, 100%);
          box-sizing: border-box;
          text-align: center;
        }
        @media (max-width: 360px) {
          .arch-node { min-width: 0; width: 100%; }
        }
        .arch-spec {
          background: var(--bg);
          border: 1px solid var(--line);
        }
        .arch-runtime {
          background: var(--accent);
          border: 1px solid var(--accent);
          padding: 18px 28px;
          box-shadow: 0 8px 24px rgba(5,150,105,0.18);
        }
        @media (max-width: 640px) {
          .arch-surfaces { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .arch-node { min-width: 240px; padding: 12px 16px; }
        }
      `}</style>
    </section>
  );
}

/** Vertical 1px connector between nodes. */
function Connector() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'block',
        width: 1,
        height: 36,
        background: 'var(--line)',
      }}
    />
  );
}
