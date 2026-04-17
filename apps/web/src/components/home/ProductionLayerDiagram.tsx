import type { CSSProperties } from 'react';

const BOX_STYLE: CSSProperties = {
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 8,
  padding: '20px 18px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  minHeight: 180,
};

const CHIP_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '6px 10px',
  borderRadius: 999,
  border: '1px solid var(--line)',
  background: 'rgba(255,255,255,0.78)',
  fontSize: 11,
  fontWeight: 600,
  color: 'var(--muted)',
  lineHeight: 1,
};

const FLOW_BOXES = [
  {
    title: 'Your app',
    eyebrow: 'Input',
    copy: 'Bring an OpenAPI spec or a hosted app. Floom keeps the app logic where it is.',
    chips: ['OpenAPI', 'Hosted', 'Preview'],
  },
  {
    title: 'Floom layer',
    eyebrow: 'Wrapped',
    copy: 'Requests pass through auth, access, logs, feedback, and secrets handling.',
    chips: ['Auth', 'Access', 'Logs', 'Feedback'],
    accent: true,
  },
  {
    title: 'Real users',
    eyebrow: 'Output',
    copy: 'The same app lands as a store page, MCP server, HTTP API, and shareable web surface.',
    chips: ['Store', 'MCP', 'HTTP', 'Web'],
  },
];

function Arrow() {
  return (
    <div aria-hidden="true" className="home-flow-arrow">
      <svg width="28" height="12" viewBox="0 0 28 12" fill="none">
        <path
          d="M1 6H25M25 6L20 1M25 6L20 11"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}

export function ProductionLayerDiagram() {
  return (
    <div className="home-flow-grid">
      {FLOW_BOXES.map((box, index) => (
        <div
          key={box.title}
          style={{
            display: 'contents',
          }}
        >
          <div
            style={{
              ...BOX_STYLE,
              background: box.accent ? 'linear-gradient(180deg, #ffffff 0%, #f3fbf7 100%)' : BOX_STYLE.background,
              borderColor: box.accent ? 'var(--accent-border)' : 'var(--line)',
            }}
          >
            <div>
              <p
                className="label-mono"
                style={{
                  margin: '0 0 8px',
                  color: box.accent ? 'var(--accent-hover)' : 'var(--muted)',
                }}
              >
                {box.eyebrow}
              </p>
              <h3
                style={{
                  margin: 0,
                  fontSize: 22,
                  fontWeight: 700,
                  color: 'var(--ink)',
                }}
              >
                {box.title}
              </h3>
            </div>
            <p
              style={{
                margin: 0,
                fontSize: 14,
                color: 'var(--muted)',
                lineHeight: 1.6,
              }}
            >
              {box.copy}
            </p>
            <div
              style={{
                display: 'flex',
                gap: 8,
                flexWrap: 'wrap',
                marginTop: 'auto',
              }}
            >
              {box.chips.map((chip) => (
                <span
                  key={chip}
                  style={{
                    ...CHIP_STYLE,
                    color: box.accent ? 'var(--accent-hover)' : CHIP_STYLE.color,
                    borderColor: box.accent ? 'var(--accent-border)' : 'var(--line)',
                    background: box.accent ? 'var(--accent-soft)' : CHIP_STYLE.background,
                  }}
                >
                  {chip}
                </span>
              ))}
            </div>
          </div>
          {index < FLOW_BOXES.length - 1 && <Arrow />}
        </div>
      ))}
    </div>
  );
}
