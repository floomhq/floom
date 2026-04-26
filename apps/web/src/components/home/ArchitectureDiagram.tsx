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
import { SectionEyebrow } from './SectionEyebrow';

interface Surface {
  label: string;
  hint: string;
  href: string;
}

// v4 (2026-04-20): labels stay dev-leaning because this section is
// explicitly tagged FOR BUILDERS by the eyebrow. Owning the audience
// lets us keep the technical names without misleading biz users.
const SURFACES: Surface[] = [
  { label: 'MCP', hint: 'Claude, Cursor', href: '/docs#mcp' },
  { label: 'HTTP', hint: 'POST /run', href: '/docs#http' },
  { label: 'CLI', hint: 'terminal', href: '/docs#cli' },
  { label: 'Chat', hint: 'in-browser', href: '/docs#chat' },
  { label: 'Link', hint: 'one URL', href: '/docs#permalink' },
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
        padding: '72px 24px',
      }}
    >
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        {/* v4: own the audience. This section is for builders, label it
            as such so biz readers can skip it without feeling lost. */}
        <header style={{ textAlign: 'center', marginBottom: 40 }}>
          <SectionEyebrow testid="architecture-eyebrow">
            For builders · how it works under the hood
          </SectionEyebrow>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: 40,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
              margin: 0,
            }}
          >
            One spec. Five surfaces.
          </h2>
        </header>

        <div className="arch-wrap">
          {/* Spec pill at the top */}
          <div className="arch-node arch-spec" aria-label="Input: your app's API or GitHub repo">
            <span
              style={{
                fontSize: 11,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              Your app
            </span>
            <span style={{ fontWeight: 600, color: 'var(--ink)', fontSize: 15 }}>
              An API URL <span style={{ color: 'var(--muted)' }}>or</span> a GitHub repo
            </span>
          </div>

          <Connector />

          {/* Floom runtime node — brand color. Text colors bumped from
              0.7/0.8 to solid white so Lighthouse color-contrast passes
              on the small-text thresholds (4.5:1 AA). */}
          <div className="arch-node arch-runtime" aria-label="Floom runtime">
            <span
              style={{
                fontSize: 11,
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                color: '#ffffff',
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
                color: '#ffffff',
                lineHeight: 1.4,
                maxWidth: 240,
                textAlign: 'center',
              }}
            >
              Runs it with auth, rate limits, logs, and versions baked in.
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
