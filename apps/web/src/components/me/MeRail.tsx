// v15.1 shared left rail. Anchors to /tmp/v15-local/me.html.
//
// Layout:
//   Brand
//   + New thread (primary CTA)
//   Your apps      (compact list; private pill on private apps)
//   Today / Yesterday / Earlier thread groups (when `threads` is supplied)
//   Footer pinned to bottom: avatar + name/email
//
// Styling uses wireframe.css custom props so the rail matches the rest of
// the product. We keep a single 280px width so the right pane gets the
// remaining space exactly like Claude / ChatGPT.

import { Link } from 'react-router-dom';
import type { CSSProperties, ReactNode } from 'react';
import { AppIcon } from '../AppIcon';
import { useMyApps } from '../../hooks/useMyApps';
import { useSession } from '../../hooks/useSession';
import type { MeRunSummary } from '../../lib/types';
import {
  groupThreads,
  threadTitle,
  threadTimeLabel,
} from '../../lib/thread';
import { WorkspaceSwitcher } from './WorkspaceSwitcher';

const RAIL_WIDTH = 280;

interface Props {
  activeAppSlug?: string;
  threads?: MeRunSummary[];
  activeThreadId?: string;
  onNewThread?: () => void;
  threadLimit?: number;
  onLoadMoreThreads?: () => void;
}

export function MeRail({
  activeAppSlug,
  threads,
  activeThreadId,
  onNewThread,
  threadLimit,
  onLoadMoreThreads,
}: Props) {
  const { apps, loading } = useMyApps();
  const { data: session } = useSession();
  const user = session?.user;
  const activeWorkspace = session?.active_workspace;
  const workspaces = session?.workspaces;

  const visibleThreads =
    threads && threadLimit ? threads.slice(0, threadLimit) : threads;
  const groups = visibleThreads ? groupThreads(visibleThreads) : null;
  const hasMore =
    threads && threadLimit ? threads.length > threadLimit : false;

  return (
    <aside
      data-testid="me-rail"
      // On narrow viewports (<720px) the 260px sidebar starves the main
      // column of horizontal space — on /me/apps/:slug this collapses the
      // description into a vertical one-char-per-line column. Hiding the
      // rail below this breakpoint restores mobile readability. Nav still
      // works via the TopBar + hamburger menu.
      className="me-rail-aside"
      style={{
        width: RAIL_WIDTH,
        flexShrink: 0,
        borderRight: '1px solid var(--line)',
        background: 'var(--bg)',
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        position: 'sticky',
        top: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '18px 16px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 14,
        }}
      >
        {onNewThread ? (
          <button
            type="button"
            onClick={onNewThread}
            data-testid="me-rail-new-thread"
            style={primaryCtaStyle}
          >
            <span style={{ fontSize: 15, lineHeight: 1 }}>+</span>
            <span>New thread</span>
          </button>
        ) : (
          <Link
            to="/me"
            data-testid="me-rail-new-thread"
            style={primaryCtaStyle}
          >
            <span style={{ fontSize: 15, lineHeight: 1 }}>+</span>
            <span>New thread</span>
          </Link>
        )}
      </div>

      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '4px 8px 12px',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
        }}
      >
        <section style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <SectionLabel>Your apps</SectionLabel>
          {loading && !apps ? (
            <RailHint>Loading…</RailHint>
          ) : apps && apps.length === 0 ? (
            <RailHint>
              No apps yet.{' '}
              <Link to="/apps" style={{ color: 'var(--accent)' }}>
                Browse public apps
              </Link>{' '}
              or{' '}
              <Link to="/build" style={{ color: 'var(--accent)' }}>
                build your own
              </Link>
              .
            </RailHint>
          ) : (
            apps?.map((app) => {
              const isActive = app.slug === activeAppSlug;
              const isPrivate = app.visibility === 'private';
              return (
                <Link
                  key={app.slug}
                  to={`/me/apps/${app.slug}`}
                  data-testid={`me-rail-app-${app.slug}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    padding: '7px 10px',
                    borderRadius: 8,
                    background: isActive ? 'var(--accent-soft)' : 'transparent',
                    color: isActive ? 'var(--accent)' : 'var(--ink)',
                    textDecoration: 'none',
                    fontSize: 13,
                    fontWeight: isActive ? 600 : 500,
                  }}
                >
                  <span
                    style={{
                      width: 22,
                      height: 22,
                      borderRadius: 6,
                      background: 'var(--card)',
                      border: '1px solid var(--line)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <AppIcon slug={app.slug} size={14} />
                  </span>
                  <span
                    style={{
                      flex: 1,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {app.name}
                  </span>
                  {isPrivate && (
                    <span
                      title="Private app — visible only to you"
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        textTransform: 'uppercase',
                        letterSpacing: '0.04em',
                        padding: '2px 6px',
                        borderRadius: 4,
                        background: 'var(--card)',
                        border: '1px solid var(--line)',
                        color: 'var(--muted)',
                        flexShrink: 0,
                      }}
                    >
                      Private
                    </span>
                  )}
                </Link>
              );
            })
          )}
        </section>

        {groups && (
          <>
            <ThreadGroupSection
              label="Today"
              runs={groups.today}
              activeThreadId={activeThreadId}
            />
            <ThreadGroupSection
              label="Yesterday"
              runs={groups.yesterday}
              activeThreadId={activeThreadId}
            />
            <ThreadGroupSection
              label="Earlier"
              runs={groups.earlier}
              activeThreadId={activeThreadId}
            />
            {hasMore && onLoadMoreThreads && (
              <button
                type="button"
                onClick={onLoadMoreThreads}
                data-testid="me-rail-load-more"
                style={{
                  margin: '0 4px',
                  padding: '8px 10px',
                  background: 'transparent',
                  border: '1px dashed var(--line)',
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 500,
                  color: 'var(--muted)',
                  cursor: 'pointer',
                }}
              >
                Load more
              </button>
            )}
          </>
        )}
      </div>

      <div
        style={{
          padding: '12px 12px 14px',
          borderTop: '1px solid var(--line)',
          background: 'var(--bg)',
        }}
      >
        {activeWorkspace && workspaces && (
          <WorkspaceSwitcher
            active={activeWorkspace}
            workspaces={workspaces}
          />
        )}
        {user ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              padding: '4px 4px',
            }}
          >
            <div
              style={{
                width: 30,
                height: 30,
                borderRadius: 999,
                background: 'var(--accent)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 12,
                fontWeight: 700,
                flexShrink: 0,
                overflow: 'hidden',
              }}
            >
              {user.image ? (
                <img
                  src={user.image}
                  alt=""
                  style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                />
              ) : (
                initials(user.name || user.email || '?')
              )}
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div
                style={{
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--ink)',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {user.name || user.email || 'Local user'}
              </div>
              {user.email && (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--muted)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {user.email}
                </div>
              )}
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)', padding: '4px 6px' }}>
            Not signed in
          </div>
        )}
      </div>
    </aside>
  );
}

const primaryCtaStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '9px 12px',
  background: 'var(--ink)',
  border: '1px solid var(--ink)',
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  color: '#fff',
  textDecoration: 'none',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        color: 'var(--muted)',
        padding: '6px 10px 4px',
      }}
    >
      {children}
    </div>
  );
}

function RailHint({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        color: 'var(--muted)',
        padding: '6px 10px 10px',
        lineHeight: 1.5,
      }}
    >
      {children}
    </div>
  );
}

function ThreadGroupSection({
  label,
  runs,
  activeThreadId,
}: {
  label: string;
  runs: MeRunSummary[];
  activeThreadId?: string;
}) {
  if (runs.length === 0) return null;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <SectionLabel>{label}</SectionLabel>
      {runs.map((run) => (
        <ThreadRow
          key={run.id}
          run={run}
          active={run.id === activeThreadId}
        />
      ))}
    </section>
  );
}

function ThreadRow({ run, active }: { run: MeRunSummary; active: boolean }) {
  const title = threadTitle(run);
  const time = threadTimeLabel(run.started_at);
  return (
    <Link
      to={`/me?thread=${encodeURIComponent(run.id)}`}
      data-testid={`me-rail-thread-${run.id}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '7px 10px',
        borderRadius: 8,
        background: active ? 'var(--accent-soft)' : 'transparent',
        color: active ? 'var(--accent)' : 'var(--ink)',
        textDecoration: 'none',
        fontSize: 13,
        fontWeight: active ? 600 : 500,
      }}
    >
      <span
        style={{
          flex: 1,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {title}
      </span>
      {time && (
        <span
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            flexShrink: 0,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {time}
        </span>
      )}
    </Link>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  if (parts.length === 0) return '?';
  return parts.map((p) => p[0]?.toUpperCase() || '').join('') || '?';
}
