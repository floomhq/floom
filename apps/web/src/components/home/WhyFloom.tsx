/**
 * WhyFloom — speaks to creators + biz users, not devs.
 *
 * ICP is locked (see memory/project_floom_positioning.md):
 *   1. Vibecoder creators (Cursor / Lovable / v0 / ChatGPT users)
 *   2. Non-technical biz users
 *
 * NOT devs, NOT platform engineers. So no "auth / rate limits /
 * renderers / Python script / Docker / OpenAPI" dev-speak. Frame
 * around the human outcome: you built something useful, now your
 * coworkers need to actually use it.
 *
 * Total visible text under 70 words (verified via DOM).
 */
import { SectionEyebrow } from './SectionEyebrow';

const BLOCKS = [
  {
    label: 'The problem',
    title: 'You built it. Now what?',
    body:
      'You vibe-coded a useful tool. A coworker wants it. You don\u2019t want to teach them a CLI.',
  },
  {
    label: 'What Floom does',
    title: 'We keep it alive.',
    body:
      'One link. Teammates open it like any website. Keys and limits handled.',
  },
  {
    label: 'How it ships',
    title: 'No engineer required.',
    body: 'Self-host it, or use the hosted version. No babysitting.',
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
          {/* v4: add the v11 "For vibecoders" eyebrow so the reader
              knows WHO this section is for in one glance. */}
          <SectionEyebrow testid="why-floom-eyebrow">
            For vibecoders shipping past the weekend
          </SectionEyebrow>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: 40,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
              margin: '0 0 10px',
            }}
          >
            AI apps need infrastructure.
          </h2>
        </header>

        {/* 2026-04-19 UX pass: removed the green uppercase eyebrow on
            each card. Redundant with the card heading and introduced a
            third color accent the page did not need. Sub-header removed
            the same day — the H2 carries enough context on its own and
            the body copy was pushing the section past the 70-word
            scannable limit. */}
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

    </section>
  );
}
