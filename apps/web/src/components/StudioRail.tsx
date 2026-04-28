/**
 * StudioRail — v26 workspace rail for Studio mode.
 *
 * v26 changes (V26-IA-SPEC §12):
 *   §12.1 — brand logo REMOVED from rail (TopBar carries it)
 *   §12.2 — same shell shape as RunRail ([Run|Studio] toggle below workspace name)
 *   §12.3/12.4 — "+ New app" is the ONLY app-entry CTA in Studio mode;
 *                no standalone "App store" item
 *   §12.5 — Docs removed from rail (moved to avatar dropdown)
 *   §12.6 — workspace settings only via identity-block click (no gear in rail)
 *   Rail: {workspace name ▾} → [Run|Studio] toggle → Apps · Runs →
 *         + New app → footer
 */

import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Box, Play, Plus } from 'lucide-react';
import { AppIcon } from './AppIcon';
import { WorkspaceIdentityBlock } from './WorkspaceIdentityBlock';
import { ModeToggle } from './ModeToggle';
import {
  RailFoot,
  RailItem,
  bodyStyle,
  headStyle,
  railStyle,
} from './RunRail';
import * as api from '../api/client';
import type { StudioAppSummary } from '../lib/types';

export function StudioRail() {
  const location = useLocation();
  const [apps, setApps] = useState<StudioAppSummary[] | null>(null);
  const firstSegment = location.pathname.match(/^\/studio\/([^/]+)/)?.[1];
  const activeSlug =
    firstSegment && !['apps', 'runs', 'build', 'new', 'overview'].includes(firstSegment)
      ? firstSegment
      : undefined;

  useEffect(() => {
    let cancelled = false;
    api
      .getStudioStats()
      .then((stats) => {
        if (!cancelled) setApps(stats.apps.items);
      })
      .catch(() => {
        if (!cancelled) setApps([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const visibleApps = useMemo(() => {
    const source = apps ?? [];
    if (!activeSlug) return source.slice(0, 5);
    const top = source.slice(0, 5);
    if (top.some((app) => app.slug === activeSlug)) return top;
    const active = source.find((app) => app.slug === activeSlug);
    return active ? [...top, active] : top;
  }, [activeSlug, apps]);

  return (
    <aside data-testid="studio-rail" aria-label="Studio navigation" style={railStyle}>
      {/* v26 §12.1: no brand here — TopBar carries the floom logo */}
      <div style={headStyle}>
        <WorkspaceIdentityBlock />
        <ModeToggle activeMode="studio" />
      </div>
      <div style={bodyStyle}>
        {/* Primary nav items */}
        <RailItem
          to="/studio/apps"
          active={
            location.pathname === '/studio/apps' ||
            (!!activeSlug && location.pathname.startsWith('/studio/'))
          }
          icon={<Box size={15} />}
          count={apps?.length}
        >
          Apps
        </RailItem>
        <RailItem
          to="/studio/runs"
          active={
            location.pathname === '/studio/runs' ||
            location.pathname.startsWith('/studio/runs/')
          }
          icon={<Play size={15} />}
        >
          Runs
        </RailItem>

        {/* Per-app quick links (active app shortcuts) */}
        {visibleApps.length > 0 && (
          <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {visibleApps.map((app) => (
              <Link
                key={app.slug}
                to={`/studio/${app.slug}`}
                aria-current={app.slug === activeSlug ? 'page' : undefined}
                style={appItemStyle(app.slug === activeSlug)}
              >
                <span style={appIconStyle}>
                  <AppIcon slug={app.slug} size={13} />
                </span>
                <span style={appNameStyle}>{app.name}</span>
              </Link>
            ))}
          </div>
        )}

        {/* v26 §12.3/12.4: "+ New app" is the single entry point in Studio */}
        <div style={{ marginTop: 'auto', paddingTop: 12 }}>
          <Link
            to="/studio/build"
            data-testid="studio-rail-new-app"
            style={primaryCtaStyle}
          >
            <Plus size={14} aria-hidden="true" />
            <span>New app</span>
          </Link>
        </div>
      </div>
      <RailFoot />
    </aside>
  );
}

const primaryCtaStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 7,
  padding: '9px 12px',
  borderRadius: 8,
  background: 'var(--ink)',
  border: '1px solid var(--ink)',
  color: '#fff',
  textDecoration: 'none',
  fontSize: 13,
  fontWeight: 700,
  width: '100%',
  boxSizing: 'border-box',
};

function appItemStyle(active: boolean): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 9,
    padding: '8px 10px',
    borderRadius: 8,
    textDecoration: 'none',
    color: active ? 'var(--ink)' : 'var(--muted)',
    background: active ? 'var(--card)' : 'transparent',
    border: active ? '1px solid var(--line)' : '1px solid transparent',
    fontSize: 13,
    fontWeight: active ? 700 : 600,
  };
}

const appIconStyle: CSSProperties = {
  width: 22,
  height: 22,
  borderRadius: 6,
  background: 'var(--card)',
  border: '1px solid var(--line)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
};

const appNameStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};
