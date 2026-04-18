import { Link } from 'react-router-dom';

export function PublicFooter() {
  return (
    <footer
      data-testid="public-footer"
      style={{
        padding: '28px 24px',
        textAlign: 'center',
        background: 'var(--card)',
        borderTop: '1px solid var(--line)',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 20,
          fontSize: 13,
          color: 'var(--muted)',
          flexWrap: 'wrap',
        }}
      >
        <span>Built in Hamburg</span>
        <span aria-hidden="true">·</span>
        <Link
          to="/docs"
          style={{ color: 'var(--muted)', textDecoration: 'none' }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLAnchorElement).style.color = 'var(--ink)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLAnchorElement).style.color = 'var(--muted)';
          }}
        >
          Docs
        </Link>
        <span aria-hidden="true">·</span>
        <Link
          to="/imprint"
          style={{ color: 'var(--muted)', textDecoration: 'none' }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLAnchorElement).style.color = 'var(--ink)';
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLAnchorElement).style.color = 'var(--muted)';
          }}
        >
          Imprint
        </Link>
      </div>
    </footer>
  );
}
