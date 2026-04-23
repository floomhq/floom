// v17 Docs hub sidebar.
//
// Lives in a grid next to the docs content panel. Groups mirror the
// wireframe at /var/www/wireframes-floom/v17/docs.html. Each group is a
// plain <section> with an uppercase eyebrow + a list of links. The
// active entry is decided by matching `currentPath` to the link's `to`.
//
// Kept intentionally dependency-light: no state, no icons, no theme
// tokens beyond CSS variables already used across the app.

import { Link } from 'react-router-dom';
import type { CSSProperties } from 'react';

export interface DocsSidebarLink {
  to: string;
  label: string;
  /** Optional trailing pill shown right-aligned, e.g. "NEW". */
  tag?: string;
}

export interface DocsSidebarGroup {
  heading: string;
  links: DocsSidebarLink[];
}

interface Props {
  groups: DocsSidebarGroup[];
  currentPath: string;
}

const asideStyle: CSSProperties = {
  borderRight: '1px solid var(--line)',
  padding: '30px 20px 30px 28px',
  background: 'transparent',
  minWidth: 0,
};

const headingStyle: CSSProperties = {
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 10.5,
  fontWeight: 600,
  color: 'var(--muted)',
  letterSpacing: '0.08em',
  textTransform: 'uppercase',
  margin: '0 0 10px',
  padding: '0 10px',
};

const listStyle: CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: '0 0 22px',
};

const linkBase: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '7px 10px',
  borderRadius: 8,
  fontSize: 13,
  color: 'var(--muted)',
  textDecoration: 'none',
  lineHeight: 1.3,
  transition: 'background 0.12s, color 0.12s',
};

const linkActive: CSSProperties = {
  ...linkBase,
  background: 'var(--ink)',
  color: '#fff',
  fontWeight: 500,
};

const tagStyle: CSSProperties = {
  marginLeft: 'auto',
  fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  fontSize: 9.5,
  color: 'var(--accent)',
  background: 'var(--accent-soft)',
  padding: '1px 6px',
  borderRadius: 4,
  fontWeight: 600,
};

const tagOnActive: CSSProperties = {
  ...tagStyle,
  color: 'var(--accent)',
  background: '#fff',
};

function isActive(linkTo: string, currentPath: string): boolean {
  // Exact match for the docs landing page, prefix match for everything
  // else so /docs/mcp-install#foo still highlights its parent.
  if (linkTo === '/docs') return currentPath === '/docs' || currentPath === '/docs/';
  return currentPath === linkTo || currentPath.startsWith(linkTo + '/');
}

export function DocsSidebar({ groups, currentPath }: Props) {
  return (
    <aside style={asideStyle} aria-label="Docs navigation">
      {groups.map((group) => (
        <section key={group.heading}>
          <h4 style={headingStyle}>{group.heading}</h4>
          <ul style={listStyle}>
            {group.links.map((link) => {
              const active = isActive(link.to, currentPath);
              const style = active ? linkActive : linkBase;
              return (
                <li key={link.to}>
                  <Link
                    to={link.to}
                    style={style}
                    onMouseEnter={(e) => {
                      if (!active) {
                        (e.currentTarget as HTMLElement).style.background = 'var(--card)';
                        (e.currentTarget as HTMLElement).style.color = 'var(--ink)';
                      }
                    }}
                    onMouseLeave={(e) => {
                      if (!active) {
                        (e.currentTarget as HTMLElement).style.background = 'transparent';
                        (e.currentTarget as HTMLElement).style.color = 'var(--muted)';
                      }
                    }}
                  >
                    <span>{link.label}</span>
                    {link.tag ? (
                      <span style={active ? tagOnActive : tagStyle}>{link.tag}</span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}

/**
 * Canonical group structure for the v17 docs hub. Every link here MUST
 * resolve to a real route registered in main.tsx — no placeholder hrefs.
 * Shared between the Docs landing page and the per-slug detail pages.
 */
export const DOCS_SIDEBAR_GROUPS: DocsSidebarGroup[] = [
  {
    heading: 'Getting started',
    links: [
      { to: '/docs', label: 'Welcome' },
      { to: '/docs/quickstart', label: 'Quickstart', tag: 'NEW' },
      { to: '/docs/cli', label: 'Install the CLI' },
      { to: '/docs/mcp-install', label: 'Install in Claude / Cursor' },
    ],
  },
  {
    heading: 'Protocol',
    links: [
      { to: '/protocol', label: 'Spec overview' },
      { to: '/docs/runtime-specs', label: 'Manifest reference' },
      { to: '/docs/ownership', label: 'Inputs and outputs' },
    ],
  },
  {
    heading: 'Runtime',
    links: [
      { to: '/docs/runtime-specs', label: 'OpenAPI vs Python apps' },
      { to: '/docs/limits', label: 'Memory, CPU, timeouts' },
      { to: '/docs/reliability', label: 'Job queue and retries' },
    ],
  },
  {
    heading: 'Deploy',
    links: [
      { to: '/docs/cli', label: 'CLI deploy' },
      { to: '/docs/self-host', label: 'Self-host with Docker' },
      { to: '/docs/self-host', label: 'Environment variables' },
    ],
  },
  {
    heading: 'API reference',
    links: [
      { to: '/docs/api-reference', label: 'Endpoints' },
      { to: '/docs/security', label: 'Auth and API keys' },
    ],
  },
  {
    heading: 'Limits and plans',
    links: [
      { to: '/docs/limits', label: 'Runtime and rate limits' },
      { to: '/docs/pricing', label: 'Free tier and self-host' },
    ],
  },
  {
    heading: 'MCP install',
    links: [
      { to: '/docs/mcp-install', label: 'Claude Desktop' },
      { to: '/docs/mcp-install', label: 'Cursor' },
      { to: '/docs/mcp-install', label: 'Codex CLI' },
    ],
  },
  {
    heading: 'Self-host',
    links: [
      { to: '/docs/self-host', label: 'Docker Compose quickstart' },
      { to: '/docs/self-host', label: 'Environment variables' },
      { to: '/docs/self-host', label: 'Update and rollback' },
    ],
  },
  {
    heading: 'Runtime specs',
    links: [
      { to: '/docs/runtime-specs', label: 'Memory, CPU, timeout' },
      { to: '/docs/runtime-specs', label: 'Lifecycle of a run' },
      { to: '/docs/runtime-specs', label: 'File inputs' },
    ],
  },
];
