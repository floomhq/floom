/**
 * ComingSoon — MVP stub card.
 *
 * Displayed in place of dashboard pages that are not part of the launch
 * MVP. Keeps routes intact so stub removal on the v26 branch produces
 * a clean diff with no route changes.
 */

import { Link } from 'react-router-dom';

interface Props {
  feature: string;
}

export function ComingSoon({ feature }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: '60vh',
        padding: '48px 24px',
      }}
    >
      <div
        style={{
          maxWidth: 460,
          width: '100%',
          background: 'var(--card)',
          border: '1px solid var(--line)',
          borderRadius: 12,
          padding: '36px 32px',
          textAlign: 'center',
        }}
      >
        <p
          style={{
            margin: '0 0 8px',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: 'var(--muted)',
          }}
        >
          Coming soon
        </p>
        <h2
          style={{
            margin: '0 0 12px',
            fontSize: 20,
            fontWeight: 700,
            color: 'var(--ink)',
            lineHeight: 1.3,
          }}
        >
          {feature}
        </h2>
        <p
          style={{
            margin: '0 0 28px',
            fontSize: 14,
            color: 'var(--muted)',
            lineHeight: 1.6,
          }}
        >
          This section is under active development. For now, use Floom via
          the MCP server in your AI tool.
        </p>
        <Link
          to="/install"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 20px',
            background: 'var(--accent)',
            color: '#fff',
            borderRadius: 8,
            fontSize: 13.5,
            fontWeight: 600,
            textDecoration: 'none',
            transition: 'opacity 0.15s',
          }}
        >
          Get the MCP install snippet
          <span aria-hidden="true" style={{ fontSize: 15 }}>→</span>
        </Link>
      </div>
    </div>
  );
}
