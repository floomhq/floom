/**
 * ProofRow — quantified trust row directly below the hero.
 *
 * One row, the fewest numbers that carry weight. No internal vocabulary
 * in the labels; creators don't care that Floom has "6 layers" or "5
 * ways to use it", those are implementation trivia. Three things
 * actually matter to the ICP landing here:
 *
 *   - N apps live (real count from /api/hub, already wired)
 *   - N runs today (optional, only shown when > 100 — otherwise we'd
 *     be bragging with a small number)
 *   - Open source · MIT (repo truth)
 *
 * 2026-04-20 (landing-v4 audit fix 2b): dropped "5 layers shipped" and
 * "5 ways to use it" per product-audit #10 — they were internal
 * vocabulary nobody was landing to learn. When we can't source 3 real
 * numbers we show 2; we don't pad.
 */

interface ProofRowProps {
  hubCount: number | null;
  /**
   * Optional count of runs executed today. Only shown when > 100 so a
   * fresh deploy doesn't brag about "12 runs today". Left-joined in by
   * the landing route's loader; absent when the server doesn't expose
   * the metric yet.
   */
  runsToday?: number | null;
}

export function ProofRow({ hubCount, runsToday }: ProofRowProps) {
  const showRunsToday = typeof runsToday === 'number' && runsToday > 100;

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
        {hubCount !== null ? (
          <Stat value={String(hubCount)} label="apps live" />
        ) : (
          <StatSkeleton label="apps live" />
        )}
        {showRunsToday && (
          <>
            <Divider />
            <Stat
              value={formatCount(runsToday!)}
              label="runs today"
            />
          </>
        )}
        <Divider />
        <Stat value="MIT" label="open source" />
      </div>

    </section>
  );
}

/**
 * Loading placeholder for the app-count stat. Replaces the previous em-dash
 * fallback which rendered as a raw "—" on fresh loads and looked like a
 * broken counter.
 *
 * Dimensioned to match the real Stat's numeric column (26px glyph height)
 * so there's zero layout shift once the real value lands.
 */
function StatSkeleton({ label }: { label: string }) {
  return (
    <span
      data-testid="home-proof-stat-skeleton"
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 4,
        minWidth: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: 48,
          height: 26,
          borderRadius: 6,
          background: 'var(--line)',
          animation: 'proof-shimmer 1.2s ease-in-out infinite',
        }}
      />
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

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.floor(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return n.toLocaleString('en-US');
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
