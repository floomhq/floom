const FLOW_STEPS = [
  {
    step: '01',
    title: 'Auth gate',
    detail: 'Optional shared-token gate for self-host, Better Auth session checks in cloud mode.',
    outcome: '401',
  },
  {
    step: '02',
    title: 'Limits and access',
    detail: 'Rate limits, workspace context, and per-app permissions resolve before app logic runs.',
    outcome: '403 / 429',
  },
  {
    step: '03',
    title: 'App execution',
    detail: 'Hosted apps or proxied OpenAPI actions execute with secrets and typed inputs attached.',
    outcome: 'run',
  },
  {
    step: '04',
    title: 'Response handling',
    detail: 'Outputs stream back through the same layer, with logs, duration, and status recorded.',
    outcome: '200',
  },
];

export function RequestFlowStack() {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {FLOW_STEPS.map((item, index) => (
        <div
          key={item.step}
          style={{
            display: 'grid',
            gridTemplateColumns: '72px minmax(0, 1fr) 72px',
            gap: 16,
            alignItems: 'center',
            padding: '18px 20px',
            borderBottom: index === FLOW_STEPS.length - 1 ? 'none' : '1px solid var(--line)',
          }}
        >
          <div
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              color: 'var(--muted)',
            }}
          >
            {item.step}
          </div>
          <div style={{ minWidth: 0 }}>
            <p
              style={{
                margin: '0 0 4px',
                fontSize: 15,
                fontWeight: 700,
                color: 'var(--ink)',
              }}
            >
              {item.title}
            </p>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: 'var(--muted)',
                lineHeight: 1.55,
              }}
            >
              {item.detail}
            </p>
          </div>
          <div
            style={{
              justifySelf: 'end',
              padding: '7px 10px',
              borderRadius: 999,
              border: '1px solid var(--line)',
              background: index >= 2 ? 'var(--accent-soft)' : 'rgba(255,255,255,0.8)',
              color: index >= 2 ? 'var(--accent-hover)' : 'var(--muted)',
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              fontWeight: 600,
              lineHeight: 1,
            }}
          >
            {item.outcome}
          </div>
        </div>
      ))}
    </div>
  );
}
