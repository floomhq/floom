/**
 * ProofRow — quantified trust row directly below the hero.
 *
 * Pulled out of the inline `hero-stats` chip into a dedicated section so
 * the numbers get room to breathe (v16 `2-proof` pattern). One row, three
 * numbers, mono for the figures, serif italic for the footnote.
 *
 * We intentionally only show truths we can verify:
 *   - live hub count (sourced from /api/hub via props)
 *   - "6 layers shipped" (matches LayersGrid cards count)
 *   - "OSS · MIT" (public repo truth)
 *
 * NO fabricated "N runs executed" or "N% uptime" — v16 showed those as
 * illustrative-with-dagger placeholders, the live landing keeps it real.
 */

interface ProofRowProps {
  hubCount: number | null;
}

export function ProofRow({ hubCount }: ProofRowProps) {
  return (
    <section
      data-testid="home-proof-row"
      data-section="proof-row"
      style={{
        background: 'var(--card)',
        borderTop: '1px solid var(--line)',
        borderBottom: '1px solid var(--line)',
        padding: '36px 24px',
      }}
    >
      <div
        className="proof-row"
        style={{
          maxWidth: 960,
          margin: '0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 48,
          flexWrap: 'wrap',
        }}
      >
        <Stat
          value={hubCount !== null ? String(hubCount) : '—'}
          label="apps running"
        />
        <Divider />
        <Stat value="6" label="layers shipped" />
        <Divider />
        <Stat value="5" label="ways to use it" />
        <Divider />
        <Stat value="MIT" label="open source" />
      </div>

      <style>{`
        @media (max-width: 640px) {
          .proof-row {
            gap: 24px !important;
          }
        }
      `}</style>
    </section>
  );
}

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 26,
          fontWeight: 600,
          color: 'var(--ink)',
          letterSpacing: '-0.02em',
          lineHeight: 1,
        }}
      >
        {value}
      </span>
      <span
        style={{
          fontFamily: "'JetBrains Mono', ui-monospace, monospace",
          fontSize: 11,
          color: 'var(--muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </span>
  );
}

function Divider() {
  return (
    <span
      aria-hidden="true"
      className="proof-divider"
      style={{
        display: 'inline-block',
        width: 1,
        height: 28,
        background: 'var(--line)',
      }}
    />
  );
}
