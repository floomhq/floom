import { useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Box, Home, KeyRound, LockKeyhole, Plus, Settings, UserRound } from 'lucide-react';
import { AppIcon } from './AppIcon';
import { WorkspaceIdentityBlock } from './WorkspaceIdentityBlock';
import {
  Brand,
  RailFoot,
  RailItem,
  RailSection,
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
  const activeSlug = firstSegment && !['apps', 'runs', 'build', 'new'].includes(firstSegment) ? firstSegment : undefined;

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
      <div style={headStyle}>
        <Brand to="/studio" label="floom" tag="Studio" />
        <WorkspaceIdentityBlock />
        <Link to="/studio/build" data-testid="studio-rail-new-app" style={primaryCtaStyle}>
          <Plus size={15} aria-hidden="true" />
          <span>New app</span>
        </Link>
      </div>
      <div style={bodyStyle}>
        <RailSection label="Studio">
          <RailItem to="/studio" active={location.pathname === '/studio'} icon={<Home size={15} />}>
            Home
          </RailItem>
          <RailItem to="/studio/apps" active={location.pathname === '/studio/apps'} icon={<Box size={15} />}>
            Apps
          </RailItem>
          <RailItem to="/studio/runs" active={location.pathname === '/studio/runs'} icon={<Home size={15} />}>
            All runs
          </RailItem>
        </RailSection>
        <RailSection label={`Apps · ${apps?.length ?? 0}`}>
          {visibleApps.length === 0 ? (
            <div style={hintStyle}>{apps === null ? 'Loading workspace apps...' : 'No apps yet.'}</div>
          ) : (
            visibleApps.map((app) => (
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
            ))
          )}
        </RailSection>
        <RailSection label="Workspace settings">
          <RailItem
            to="/settings/byok-keys"
            active={location.pathname === '/settings/byok-keys'}
            icon={<LockKeyhole size={15} />}
          >
            BYOK keys
          </RailItem>
          <RailItem
            to="/settings/agent-tokens"
            active={location.pathname === '/settings/agent-tokens'}
            icon={<KeyRound size={15} />}
          >
            Agent tokens
          </RailItem>
          <RailItem
            to="/settings/studio"
            active={location.pathname === '/settings/studio'}
            icon={<Settings size={15} />}
          >
            Studio settings
          </RailItem>
        </RailSection>
        <RailSection label="Account">
          <RailItem
            to="/account/settings"
            active={location.pathname === '/account/settings'}
            icon={<UserRound size={15} />}
          >
            Account settings
          </RailItem>
        </RailSection>
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
};

const hintStyle: CSSProperties = {
  color: 'var(--muted)',
  fontSize: 12,
  lineHeight: 1.45,
  padding: '6px 10px',
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
