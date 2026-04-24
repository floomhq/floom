// v17 Docs hub sidebar.
//
// Lives in a grid next to the docs content panel. Groups mirror the
// wireframe at /var/www/wireframes-floom/v17/docs.html. Each group is a
// plain <section> with a row heading (icon + label) plus a list of
// links. The active entry is decided by matching `currentPath` to the
// link's `to`.
//
// Docs-sexier pass (2026-04-24):
// - Each group heading gets a neutral lucide icon to the left so the
//   sidebar reads at a glance (Getting started / Examples / Protocol /
//   Runtime / Deploy / API reference…). Icons are stroke-only, colored
//   --muted, stay neutral on active state. No emojis.
// - Active link: tinted background + bold weight, no colored left
//   border (design rule: no colored left borders on cards — AI slop).
//   Background-only active state keeps the palette restrained.
// - Hover: subtle card-tint bg, not green.
// - Mobile: drawer toggle with hamburger icon, closes on link click,
//   is the only thing visible on docs landing at 390px.

import { Link } from 'react-router-dom';
import { useState } from 'react';
import type { CSSProperties } from 'react';
import {
  Rocket,
  Play,
  FileText,
  Cpu,
  Server,
  BookOpen,
  Gauge,
  Package,
  Terminal,
  Layers,
  Menu,
  X,
  ChevronRight,
  Compass,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface DocsSidebarLink {
  to: string;
  label: string;
  /** Optional trailing pill shown right-aligned, e.g. "NEW". */
  tag?: string;
}

export interface DocsSidebarGroup {
  heading: string;
  links: DocsSidebarLink[];
  /** Optional override icon; otherwise looked up by heading. */
  icon?: LucideIcon;
}

interface Props {
  groups: DocsSidebarGroup[];
  currentPath: string;
}

// Neutral stroke icons per section. Fallback Compass keeps the layout
// consistent if a future group heading isn't in the map yet.
const HEADING_ICONS: Record<string, LucideIcon> = {
  'Getting started': Rocket,
  Examples: Play,
  Protocol: FileText,
  Runtime: Cpu,
  Deploy: Server,
  'API reference': BookOpen,
  'Limits and plans': Gauge,
  'MCP install': Package,
  'Self-host': Terminal,
  'Runtime specs': Layers,
};

function iconForHeading(heading: string): LucideIcon {
  return HEADING_ICONS[heading] ?? Compass;
}

const asideStyle: CSSProperties = {
  borderRight: '1px solid var(--line)',
  padding: '30px 20px 30px 28px',
  background: 'transparent',
  minWidth: 0,
  // Desktop: stick the sidebar below the TopBar + waitlist banner so it
  // stays in view while the article scrolls. On mobile the wrapper
  // disables sticky via the `docs-sidebar` class so the collapsible
  // drawer lives at the top of the flow.
  position: 'sticky',
  top: 0,
  alignSelf: 'start',
  maxHeight: '100vh',
  overflowY: 'auto',
};

const mobileToggleStyle: CSSProperties = {
  display: 'none',
  width: '100%',
  alignItems: 'center',
  gap: 10,
  padding: '10px 14px',
  background: 'var(--card)',
  border: '1px solid var(--line)',
  borderRadius: 10,
  fontSize: 13,
  fontWeight: 600,
  color: 'var(--ink)',
  cursor: 'pointer',
  fontFamily: 'inherit',
  textAlign: 'left',
};

const headingRowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
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

// Link row — background-only active state (no colored left border,
// per design rule "no colored left borders on cards").
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
  background: 'var(--accent-soft)',
  color: 'var(--ink)',
  fontWeight: 600,
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
  border: '1px solid var(--accent-border, transparent)',
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
  const [mobileOpen, setMobileOpen] = useState(false);
  // Label the mobile toggle with the active group+link so the closed
  // drawer doubles as breadcrumbs.
  const activeLabel = (() => {
    for (const group of groups) {
      const hit = group.links.find((link) => isActive(link.to, currentPath));
      if (hit) return `${group.heading} / ${hit.label}`;
    }
    return 'Docs navigation';
  })();

  return (
    <aside className="docs-sidebar" style={asideStyle} aria-label="Docs navigation">
      <button
        type="button"
        className="docs-sidebar-mobile-toggle"
        style={mobileToggleStyle}
        aria-expanded={mobileOpen}
        aria-controls="docs-sidebar-groups"
        onClick={() => setMobileOpen((v) => !v)}
      >
        {mobileOpen ? (
          <X size={16} strokeWidth={1.8} aria-hidden="true" />
        ) : (
          <Menu size={16} strokeWidth={1.8} aria-hidden="true" />
        )}
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {mobileOpen ? 'Close menu' : activeLabel}
        </span>
        {!mobileOpen ? (
          <ChevronRight
            size={14}
            strokeWidth={1.8}
            aria-hidden="true"
            style={{ color: 'var(--muted)' }}
          />
        ) : null}
      </button>
      <div
        id="docs-sidebar-groups"
        className={`docs-sidebar-groups${mobileOpen ? ' is-open' : ''}`}
      >
        {groups.map((group) => {
          const Icon = group.icon ?? iconForHeading(group.heading);
          return (
            <section key={group.heading}>
              <h4 style={headingRowStyle}>
                <Icon
                  size={13}
                  strokeWidth={1.8}
                  aria-hidden="true"
                  style={{ color: 'var(--muted)', flex: 'none' }}
                />
                <span>{group.heading}</span>
              </h4>
              <ul style={listStyle}>
                {group.links.map((link) => {
                  const active = isActive(link.to, currentPath);
                  const style = active ? linkActive : linkBase;
                  return (
                    <li key={`${link.to}-${link.label}`}>
                      <Link
                        to={link.to}
                        style={style}
                        onClick={() => setMobileOpen(false)}
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
          );
        })}
      </div>
      <style>{`
        @media (max-width: 900px) {
          .docs-sidebar {
            position: static !important;
            max-height: none !important;
            border-right: none !important;
            border-bottom: 1px solid var(--line);
            padding: 16px 16px !important;
          }
          .docs-sidebar-mobile-toggle { display: flex !important; }
          .docs-sidebar-groups { display: none; margin-top: 12px; }
          .docs-sidebar-groups.is-open { display: block; }
        }
      `}</style>
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
  // v17 Examples group (#549). Each link goes to a runnable app on
  // /p/<slug>; /docs/examples is the markdown index with deploy snippets.
  {
    heading: 'Examples',
    links: [
      { to: '/docs/examples', label: 'All examples' },
      { to: '/p/lead-scorer', label: 'Lead scorer' },
      { to: '/p/competitor-analyzer', label: 'Competitor analyzer' },
      { to: '/p/resume-screener', label: 'Resume screener' },
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
