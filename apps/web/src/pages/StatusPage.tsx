import { PageShell } from '../components/PageShell';

const SYSTEMS = [
  { name: 'Web app', note: 'Public pages, Store, and run surfaces.' },
  { name: 'Runtime API', note: 'HTTP, MCP, and CLI run endpoints.' },
  { name: 'Workspace data', note: 'Runs, BYOK keys, apps, and account state.' },
  { name: 'Transactional email', note: 'Verification, password reset, and invites.' },
];

export function StatusPage() {
  return (
    <PageShell title="Status · Floom">
      <main style={{ maxWidth: 760, margin: '0 auto', padding: '56px 20px 72px' }}>
        <p
          style={{
            margin: '0 0 10px',
            fontFamily: "'JetBrains Mono', ui-monospace, monospace",
            fontSize: 12,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--accent)',
            fontWeight: 700,
          }}
        >
          Status
        </p>
        <h1
          style={{
            margin: '0 0 14px',
            fontFamily: 'var(--font-display)',
            fontWeight: 800,
            fontSize: 44,
            lineHeight: 1.05,
            letterSpacing: '-0.025em',
          }}
        >
          Floom system status
        </h1>
        <p style={{ margin: '0 0 28px', color: 'var(--muted)', lineHeight: 1.6 }}>
          Public uptime reporting is coming soon. During launch, incidents and
          degraded service notices are posted in Discord and reflected here.
        </p>

        <section
          style={{
            border: '1px solid var(--line)',
            borderRadius: 8,
            background: 'var(--card)',
            overflow: 'hidden',
          }}
        >
          {SYSTEMS.map((system, idx) => (
            <div
              key={system.name}
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 16,
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '16px 18px',
                borderTop: idx === 0 ? 'none' : '1px solid var(--line)',
              }}
            >
              <strong style={{ fontSize: 14, minWidth: 140 }}>{system.name}</strong>
              <span style={{ color: 'var(--muted)', fontSize: 14, lineHeight: 1.5, flex: '1 1 240px' }}>
                {system.note}
              </span>
              <span
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 7,
                  color: 'var(--accent)',
                  fontSize: 13,
                  fontWeight: 700,
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: 'var(--accent)',
                  }}
                />
                Operational
              </span>
            </div>
          ))}
        </section>

        <p style={{ margin: '18px 0 0', color: 'var(--muted)', fontSize: 14, lineHeight: 1.6 }}>
          For urgent production issues, email{' '}
          <a href="mailto:team@floom.dev" style={{ color: 'var(--accent)', fontWeight: 700 }}>
            team@floom.dev
          </a>
          .
        </p>
      </main>
    </PageShell>
  );
}
