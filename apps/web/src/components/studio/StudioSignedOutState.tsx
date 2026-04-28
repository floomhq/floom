import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';

const wrapStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 20,
};

const heroStyle: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 12,
  background: 'var(--card)',
  padding: '28px 28px 24px',
};

const ctaRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 10,
  marginTop: 18,
};

const primaryCtaStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '10px 16px',
  borderRadius: 8,
  background: 'var(--ink)',
  border: '1px solid var(--ink)',
  color: '#fff',
  fontSize: 13,
  fontWeight: 600,
  textDecoration: 'none',
};

const secondaryCtaStyle: CSSProperties = {
  ...primaryCtaStyle,
  background: 'var(--bg)',
  border: '1px solid var(--line)',
  color: 'var(--ink)',
};

const gridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  gap: 12,
};

const cardStyle: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 12,
  background: 'rgba(255,255,255,0.72)',
  padding: '18px 18px 16px',
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
};

const sectionMap = [
  {
    title: 'Publish',
    body: 'Start from a repo or OpenAPI spec.',
  },
  {
    title: 'Runs',
    body: 'See every execution, who ran it, and timing.',
  },
  {
    title: 'App creator secrets',
    body: 'Store app creator secrets once, scoped per app.',
  },
  {
    title: 'Analytics',
    body: 'Monitor usage and health.',
  },
] as const;

export function StudioSignedOutState() {
  return (
    <section
      data-testid="studio-signed-out-shell"
      aria-label="Studio"
      style={wrapStyle}
    >
      <div style={heroStyle}>
        <h1
          style={{
            fontSize: 30,
            fontWeight: 700,
            color: 'var(--ink)',
            margin: '0 0 10px',
          }}
        >
          Studio
        </h1>
        <p
          style={{
            margin: 0,
            maxWidth: 640,
            fontSize: 15,
            lineHeight: 1.65,
            color: 'var(--muted)',
          }}
        >
          Publish apps from a repo or OpenAPI spec, manage app creator secrets, and see
          every run.
        </p>

        <div style={ctaRowStyle}>
          <Link to="/login?next=%2Fstudio" style={primaryCtaStyle}>
            Sign in to open Studio
          </Link>
          <Link to="/apps" style={secondaryCtaStyle}>
            Browse live apps
          </Link>
        </div>
      </div>

      <div style={gridStyle}>
        {sectionMap.map((item) => (
          <article key={item.title} style={cardStyle}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'var(--ink)' }}>
              {item.title}
            </div>
            <p
              style={{
                margin: 0,
                fontSize: 13,
                lineHeight: 1.55,
                color: 'var(--muted)',
              }}
            >
              {item.body}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
