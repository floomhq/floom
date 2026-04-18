// v15.1 mobile /me layout (≤ 640px).
//
// Two tabs: "Threads" (flat chronological list grouped by date) and
// "Apps · N" (the user's app list + link to browse public apps). A big
// "+" button in the top-right starts a new thread — i.e. opens the
// active app or sends the user to /apps if nothing is installed.

import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AppIcon } from '../AppIcon';
import { Logo } from '../Logo';
import type { CreatorApp, MeRunSummary } from '../../lib/types';
import {
  groupThreads,
  threadTitle,
  threadTimeLabel,
} from '../../lib/thread';

type Tab = 'threads' | 'apps';

interface Props {
  threads: MeRunSummary[];
  apps: CreatorApp[];
  onNewThread: () => void;
}

export function MeMobile({ threads, apps, onNewThread }: Props) {
  const [tab, setTab] = useState<Tab>('threads');

  return (
    <div
      data-testid="me-mobile"
      style={{
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        background: 'var(--bg)',
      }}
    >
      <header
        style={{
          padding: '14px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          borderBottom: '1px solid var(--line)',
          background: 'var(--card)',
          position: 'sticky',
          top: 0,
          zIndex: 2,
        }}
      >
        <Link
          to="/"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            textDecoration: 'none',
            color: 'var(--ink)',
            fontWeight: 700,
            fontSize: 15,
          }}
        >
          <Logo size={22} />
          <span>floom</span>
        </Link>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onNewThread}
          data-testid="me-mobile-new-thread"
          aria-label="New thread"
          style={{
            width: 40,
            height: 40,
            borderRadius: 999,
            background: 'var(--ink)',
            color: '#fff',
            border: '1px solid var(--ink)',
            fontSize: 20,
            fontWeight: 600,
            lineHeight: 1,
            cursor: 'pointer',
          }}
        >
          +
        </button>
      </header>

      <nav
        style={{
          display: 'flex',
          gap: 4,
          padding: '10px 12px',
          borderBottom: '1px solid var(--line)',
          background: 'var(--card)',
        }}
      >
        <TabButton
          active={tab === 'threads'}
          onClick={() => setTab('threads')}
          testId="me-mobile-tab-threads"
        >
          Threads
        </TabButton>
        <TabButton
          active={tab === 'apps'}
          onClick={() => setTab('apps')}
          testId="me-mobile-tab-apps"
        >
          Apps · {apps.length}
        </TabButton>
      </nav>

      <main style={{ flex: 1, padding: '4px 0 40px' }}>
        {tab === 'threads' ? (
          <ThreadsList threads={threads} />
        ) : (
          <AppsList apps={apps} />
        )}
      </main>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      style={{
        flex: 1,
        padding: '9px 12px',
        borderRadius: 8,
        border: '1px solid var(--line)',
        background: active ? 'var(--ink)' : 'var(--bg)',
        color: active ? '#fff' : 'var(--ink)',
        fontSize: 13,
        fontWeight: 600,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}

function ThreadsList({ threads }: { threads: MeRunSummary[] }) {
  const navigate = useNavigate();
  if (threads.length === 0) {
    return (
      <div
        style={{
          padding: '40px 24px',
          textAlign: 'center',
          color: 'var(--muted)',
          fontSize: 14,
          lineHeight: 1.6,
        }}
      >
        No threads yet. Tap <strong>+</strong> to start one.
      </div>
    );
  }
  const groups = groupThreads(threads);
  return (
    <div style={{ padding: '8px 0' }}>
      <Group label="Today" runs={groups.today} onOpen={openThread} />
      <Group label="Yesterday" runs={groups.yesterday} onOpen={openThread} />
      <Group label="Earlier" runs={groups.earlier} onOpen={openThread} />
    </div>
  );

  function openThread(run: MeRunSummary) {
    navigate(`/me?thread=${encodeURIComponent(run.id)}`);
  }
}

function Group({
  label,
  runs,
  onOpen,
}: {
  label: string;
  runs: MeRunSummary[];
  onOpen: (run: MeRunSummary) => void;
}) {
  if (runs.length === 0) return null;
  return (
    <section style={{ padding: '4px 0 10px' }}>
      <div
        style={{
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          color: 'var(--muted)',
          padding: '6px 20px',
        }}
      >
        {label}
      </div>
      {runs.map((run) => (
        <button
          key={run.id}
          type="button"
          onClick={() => onOpen(run)}
          data-testid={`me-mobile-thread-${run.id}`}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '10px 20px',
            border: 'none',
            background: 'transparent',
            textAlign: 'left',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {run.app_slug && (
            <span
              style={{
                width: 26,
                height: 26,
                borderRadius: 6,
                background: 'var(--card)',
                border: '1px solid var(--line)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <AppIcon slug={run.app_slug} size={14} />
            </span>
          )}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                fontWeight: 500,
                color: 'var(--ink)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {threadTitle(run)}
            </div>
            <div
              style={{
                fontSize: 11,
                color: 'var(--muted)',
                marginTop: 2,
                display: 'flex',
                gap: 6,
              }}
            >
              <span>{run.app_name || run.app_slug || 'App'}</span>
              <span>·</span>
              <span>{threadTimeLabel(run.started_at)}</span>
            </div>
          </div>
        </button>
      ))}
    </section>
  );
}

function AppsList({ apps }: { apps: CreatorApp[] }) {
  return (
    <div style={{ padding: '8px 0 16px' }}>
      {apps.length === 0 ? (
        <div
          style={{
            padding: '20px 24px',
            color: 'var(--muted)',
            fontSize: 14,
            lineHeight: 1.6,
          }}
        >
          No apps yet.
        </div>
      ) : (
        apps.map((app) => (
          <Link
            key={app.slug}
            to={`/me/a/${app.slug}`}
            data-testid={`me-mobile-app-${app.slug}`}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '12px 20px',
              textDecoration: 'none',
              color: 'var(--ink)',
            }}
          >
            <span
              style={{
                width: 32,
                height: 32,
                borderRadius: 8,
                background: 'var(--card)',
                border: '1px solid var(--line)',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <AppIcon slug={app.slug} size={18} />
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {app.name}
              </div>
              <div
                style={{
                  fontSize: 11,
                  color: 'var(--muted)',
                  marginTop: 2,
                  textTransform: 'capitalize',
                }}
              >
                {app.visibility}
              </div>
            </div>
          </Link>
        ))
      )}
      <div style={{ padding: '20px 20px 0' }}>
        <Link
          to="/apps"
          data-testid="me-mobile-browse-public"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '10px 14px',
            border: '1px solid var(--line)',
            borderRadius: 8,
            background: 'var(--card)',
            color: 'var(--ink)',
            fontSize: 13,
            fontWeight: 600,
            textDecoration: 'none',
          }}
        >
          Browse public apps →
        </Link>
      </div>
    </div>
  );
}
