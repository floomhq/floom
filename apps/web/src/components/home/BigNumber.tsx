/**
 * BigNumber — oversized pullquote / stat panel.
 *
 * Adds section-shape variety to a landing that was all centered-card-
 * grid. One big number, one short punchline. Sits between the
 * walkthrough and the MCP snippet sections.
 */
import { SectionEyebrow } from './SectionEyebrow';

export function BigNumber() {
  return (
    <section
      data-testid="home-big-number"
      data-section="big-number"
      style={{
        background: 'var(--bg)',
        padding: '104px 24px',
        borderTop: '1px solid var(--line)',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div
        style={{
          maxWidth: 960,
          margin: '0 auto',
          textAlign: 'center',
        }}
      >
        <SectionEyebrow tone="accent" testid="big-number-eyebrow">
          Repo in · app out
        </SectionEyebrow>
        <p
          className="big-number-headline"
          style={{
            fontFamily: "'DM Serif Display', Georgia, serif",
            fontWeight: 400,
            fontSize: 88,
            lineHeight: 1,
            letterSpacing: '-0.035em',
            color: 'var(--ink)',
            margin: '0 0 18px',
          }}
        >
          3 minutes.
        </p>
        <p
          style={{
            fontSize: 18,
            lineHeight: 1.5,
            color: 'var(--muted)',
            margin: 0,
            maxWidth: 560,
            marginLeft: 'auto',
            marginRight: 'auto',
            textWrap: 'balance' as unknown as 'balance',
          }}
        >
          From a GitHub repo to a link your teammate can click.
        </p>
      </div>

      <style>{`
        @media (max-width: 640px) {
          .big-number-headline { font-size: 64px !important; }
        }
      `}</style>
    </section>
  );
}
