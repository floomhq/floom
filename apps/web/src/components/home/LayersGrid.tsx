/**
 * LayersGrid — 3-step walkthrough with real product screenshots.
 *
 * Replaces the old 5-card icon grid (2026-04-22 goosebumps pass). The
 * icon-grid was "PowerPoint-tier" per Federico: a flat card row that
 * showed nothing of the product. This section now demonstrates the
 * whole flow in three screenshots, in order:
 *
 *   01  Paste a GitHub repo      → real hero input
 *   02  Floom builds the page    → real /p/lead-scorer page
 *   03  Teammate clicks Run      → real run with live output
 *
 * Desktop: horizontal 3-column with 01/02/03 numeric labels.
 * Mobile : vertical stack.
 *
 * Assets: apps/web/public/landing-shots/step-{1-hero,2-product-page,3-run}.png
 * (captured against preview.floom.dev at 1440x820 clip).
 *
 * Component name kept as `LayersGrid` so we don't churn the import graph
 * in CreatorHeroPage. The section still sits at the same position.
 */
import { SectionEyebrow } from './SectionEyebrow';

interface Step {
  number: string;
  title: string;
  caption: string;
  shot: string;
  alt: string;
}

const STEPS: Step[] = [
  {
    number: '01',
    title: 'Paste a GitHub repo',
    caption: 'Any repo with an OpenAPI spec. No setup.',
    shot: '/landing-shots/step-1-hero.png',
    alt: 'Floom hero with a GitHub URL input',
  },
  {
    number: '02',
    title: 'Floom builds the page',
    caption: 'A clean product page, ready to share.',
    shot: '/landing-shots/step-2-product-page.png',
    alt: 'A Floom product page for Lead Scorer',
  },
  {
    number: '03',
    title: 'Teammate clicks Run',
    caption: 'They get real output, not raw JSON.',
    shot: '/landing-shots/step-3-run.png',
    alt: 'A Floom app run showing decoded JWT fields',
  },
];

export function LayersGrid() {
  return (
    <section
      data-testid="home-walkthrough"
      data-section="walkthrough"
      style={{
        background: 'var(--card)',
        borderTop: '1px solid var(--line)',
        borderBottom: '1px solid var(--line)',
        padding: '88px 24px',
      }}
    >
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <header style={{ textAlign: 'center', marginBottom: 48 }}>
          <SectionEyebrow testid="walkthrough-eyebrow">
            Three steps, three minutes
          </SectionEyebrow>
          <h2
            style={{
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontWeight: 400,
              fontSize: 44,
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
              margin: 0,
            }}
          >
            From repo to shareable app.
          </h2>
        </header>

        <div
          className="walkthrough-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 28,
          }}
        >
          {STEPS.map((s) => (
            <article
              key={s.number}
              data-testid={`walkthrough-step-${s.number}`}
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 14,
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 12,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--accent)',
                    letterSpacing: '0.08em',
                  }}
                >
                  {s.number}
                </span>
                <h3
                  style={{
                    fontSize: 19,
                    fontWeight: 700,
                    color: 'var(--ink)',
                    margin: 0,
                    letterSpacing: '-0.01em',
                    lineHeight: 1.25,
                  }}
                >
                  {s.title}
                </h3>
              </div>
              <div
                style={{
                  position: 'relative',
                  borderRadius: 14,
                  overflow: 'hidden',
                  border: '1px solid var(--line)',
                  background: 'var(--bg)',
                  aspectRatio: '16 / 10',
                  boxShadow:
                    '0 1px 0 rgba(0,0,0,0.02), 0 8px 24px rgba(5,150,105,0.06)',
                }}
              >
                <img
                  src={s.shot}
                  alt={s.alt}
                  loading="lazy"
                  decoding="async"
                  style={{
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                    objectPosition: 'top',
                    display: 'block',
                  }}
                />
              </div>
              <p
                style={{
                  fontSize: 14,
                  color: 'var(--muted)',
                  lineHeight: 1.55,
                  margin: 0,
                }}
              >
                {s.caption}
              </p>
            </article>
          ))}
        </div>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .walkthrough-grid { grid-template-columns: minmax(0, 1fr) !important; gap: 32px !important; }
        }
      `}</style>
    </section>
  );
}
