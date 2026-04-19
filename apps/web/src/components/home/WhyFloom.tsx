/**
 * WhyFloom — short, sharp problem / solution / proof block.
 *
 * Copy intentionally short (~40 words each), no em dashes, no
 * ai-slop. Reads as a blog intro, not a marketing paragraph.
 */

const BLOCKS = [
  {
    label: 'The problem',
    title: 'AI apps are toys because they have no infra.',
    body:
      'Every team re-invents auth, rate limits, logs, secrets, renderers. Then their "agent" is a Python script stuck on someone\u2019s laptop, or a demo that dies when the founder goes to bed.',
  },
  {
    label: 'What Floom does',
    title: 'Floom is the missing layer.',
    body:
      'Ship an OpenAPI spec or a GitHub repo. Get MCP, HTTP, a shareable web form, a CLI, and a chat surface. Production-grade secrets, rate limits, and logging are built in, not bolted on.',
  },
  {
    label: 'How it ships',
    title: 'Open source, Docker-first.',
    body:
      'Six real layers ship today: ingest, runtime, secrets, memory, runs, renderer. Self-host in 30 seconds. Or use the hosted version when you want the creator tools without babysitting a box.',
  },
];

export function WhyFloom() {
  return (
    <section
      data-testid="home-why-floom"
      data-section="why-floom"
      style={{
        background: 'var(--bg)',
        padding: '72px 24px',
      }}
    >
      <div style={{ maxWidth: 960, margin: '0 auto' }}>
        <header style={{ textAlign: 'center', marginBottom: 36 }}>
          <h2
            style={{
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontWeight: 400,
              fontSize: 40,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
              margin: '0 0 10px',
            }}
          >
            AI apps need infrastructure.
          </h2>
          <p
            style={{
              fontSize: 15,
              color: 'var(--muted)',
              lineHeight: 1.55,
              maxWidth: 520,
              margin: '0 auto',
            }}
          >
            Why we built Floom, and what it does for the agents you already
            have.
          </p>
        </header>

        {/* 2026-04-19 UX pass: removed the green uppercase eyebrow on
            each card. Redundant with the card heading and introduced a
            third color accent the page did not need. */}
        <div
          className="why-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
            gap: 18,
          }}
        >
          {BLOCKS.map((b) => (
            <article
              key={b.label}
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 14,
                padding: 22,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
              }}
            >
              <h3
                data-label={b.label}
                style={{
                  fontSize: 19,
                  fontWeight: 700,
                  color: 'var(--ink)',
                  lineHeight: 1.3,
                  margin: 0,
                  letterSpacing: '-0.01em',
                }}
              >
                {b.title}
              </h3>
              <p
                style={{
                  fontSize: 14.5,
                  color: 'var(--muted)',
                  lineHeight: 1.6,
                  margin: 0,
                }}
              >
                {b.body}
              </p>
            </article>
          ))}
        </div>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .why-grid { grid-template-columns: 1fr !important; }
        }
      `}</style>
    </section>
  );
}
