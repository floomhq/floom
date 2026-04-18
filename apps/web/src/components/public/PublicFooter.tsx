import { Link } from 'react-router-dom';

// Landing visual audit 2026-04-18 finding: PublicFooter only had Docs +
// Imprint, so cold public visitors from HN/PH had no path to Privacy,
// Terms, Cookies, or the open-source GitHub repo: major trust + EU
// compliance gap. Expanded to match the signed-in Footer.tsx link set
// while keeping the landing's centered, muted, one-line rhythm.
const LINK_STYLE: React.CSSProperties = { color: 'var(--muted)', textDecoration: 'none' };

function FootLink({ children, to, href }: { children: React.ReactNode; to?: string; href?: string }) {
  const common = {
    style: LINK_STYLE,
    onMouseEnter: (e: React.MouseEvent<HTMLAnchorElement>) => {
      (e.currentTarget as HTMLAnchorElement).style.color = 'var(--ink)';
    },
    onMouseLeave: (e: React.MouseEvent<HTMLAnchorElement>) => {
      (e.currentTarget as HTMLAnchorElement).style.color = 'var(--muted)';
    },
  };
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" {...common}>{children}</a>
  ) : (
    <Link to={to!} {...common}>{children}</Link>
  );
}

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
          columnGap: 16,
          rowGap: 8,
          fontSize: 13,
          color: 'var(--muted)',
          flexWrap: 'wrap',
        }}
      >
        <span>Built in Hamburg</span>
        <span aria-hidden="true">·</span>
        <FootLink to="/docs">Docs</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink href="https://github.com/floomhq/floom">GitHub</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/imprint">Imprint</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/privacy">Privacy</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/terms">Terms</FootLink>
        <span aria-hidden="true">·</span>
        <FootLink to="/cookies">Cookies</FootLink>
      </div>
    </footer>
  );
}
