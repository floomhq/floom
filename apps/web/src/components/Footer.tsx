import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer
      style={{
        maxWidth: 900,
        margin: '0 auto',
        padding: '32px 24px 48px',
        display: 'flex',
        flexWrap: 'wrap',
        gap: 16,
        alignItems: 'center',
        justifyContent: 'space-between',
      }}
    >
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>
        Built in Hamburg by{' '}
        <a
          href="https://github.com/federicodeponte"
          target="_blank"
          rel="noreferrer"
          style={{
            color: 'var(--ink)',
            textDecoration: 'underline',
            textDecorationThickness: '1px',
            textUnderlineOffset: '2px',
          }}
        >
          Federico De Ponte
        </a>{' '}
        and contributors.
      </p>
      <nav style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        <Link to="/apps" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>apps</Link>
        <Link to="/protocol" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>protocol</Link>
        <a href="https://github.com/floomhq/floom-monorepo" target="_blank" rel="noreferrer" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>github</a>
        <Link to="/imprint" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>imprint</Link>
        <Link to="/privacy" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>privacy</Link>
        <Link to="/terms" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>terms</Link>
        <Link to="/cookies" style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}>cookies</Link>
      </nav>
    </footer>
  );
}
