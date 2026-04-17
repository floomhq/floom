const SHIPPED_ITEMS = [
  'Self-host with Docker plus an apps.yaml config.',
  'Store pages, MCP servers, HTTP endpoints, and shareable web forms.',
  'Auth gating, feedback capture, reviews, encrypted user secrets, and app memory.',
  'Creator dashboard, OpenAPI ingest flow, and workspace-aware sessions in cloud mode.',
];

const STAGED_ITEMS = [
  'Workspace switcher UI for multi-org accounts.',
  'Connected-tools UI on /me for Composio-backed OAuth flows.',
  'Creator monetization UI for Stripe Connect.',
  'Async jobs, custom renderers, and the remaining app-memory surface.',
];

function TruthCard({
  eyebrow,
  title,
  items,
  accent,
}: {
  eyebrow: string;
  title: string;
  items: string[];
  accent?: boolean;
}) {
  return (
    <div
      style={{
        background: accent ? 'linear-gradient(180deg, #ffffff 0%, #f5fbf7 100%)' : 'var(--card)',
        border: `1px solid ${accent ? 'var(--accent-border)' : 'var(--line)'}`,
        borderRadius: 8,
        padding: '24px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        minHeight: 100,
      }}
    >
      <div>
        <p
          className="label-mono"
          style={{
            margin: '0 0 8px',
            color: accent ? 'var(--accent-hover)' : 'var(--muted)',
          }}
        >
          {eyebrow}
        </p>
        <h3
          style={{
            margin: 0,
            fontSize: 24,
            fontWeight: 700,
            color: 'var(--ink)',
          }}
        >
          {title}
        </h3>
      </div>
      <div
        style={{
          display: 'grid',
          gap: 12,
        }}
      >
        {items.map((item) => (
          <div
            key={item}
            style={{
              display: 'grid',
              gridTemplateColumns: '18px minmax(0, 1fr)',
              gap: 10,
              alignItems: 'start',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: 18,
                height: 18,
                borderRadius: '50%',
                background: accent ? 'var(--accent)' : 'var(--line)',
                color: accent ? '#fff' : 'var(--muted)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 700,
                lineHeight: 1,
                marginTop: 1,
              }}
            >
              {accent ? '✓' : '+'}
            </span>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                color: 'var(--muted)',
                lineHeight: 1.6,
              }}
            >
              {item}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ScopeTruthGrid() {
  return (
    <div className="home-scope-grid">
      <TruthCard
        eyebrow="Works today"
        title="Current surface"
        items={SHIPPED_ITEMS}
        accent={true}
      />
      <TruthCard
        eyebrow="Still staged"
        title="Next UI ramps"
        items={STAGED_ITEMS}
      />
    </div>
  );
}
