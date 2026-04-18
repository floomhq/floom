// v15.1 right-hand pane. Given one run (treated as a single-turn
// "thread"), render the user's prompt + the app's response with an
// "Open in full →" deep-link to /me/a/<slug>/run and the standard
// header used across /me wireframes.

import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AppIcon } from '../AppIcon';
import type { AppVisibility, MeRunDetail, MeRunSummary } from '../../lib/types';
import { threadTitle } from '../../lib/thread';

interface Props {
  thread: MeRunSummary;
  detail: MeRunDetail | null;
  detailError?: string | null;
  appVisibility?: AppVisibility;
}

export function MeThreadPane({
  thread,
  detail,
  detailError,
  appVisibility,
}: Props) {
  const title = threadTitle(thread);
  const appSlug = thread.app_slug;
  const appName = thread.app_name || appSlug || 'App';

  return (
    <div
      data-testid="me-thread-pane"
      style={{
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        overflow: 'hidden',
        background: 'var(--bg)',
      }}
    >
      <header
        style={{
          padding: '16px 24px',
          borderBottom: '1px solid var(--line)',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexShrink: 0,
          background: 'var(--card)',
        }}
      >
        {appSlug && (
          <span
            style={{
              width: 28,
              height: 28,
              borderRadius: 8,
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <AppIcon slug={appSlug} size={16} />
          </span>
        )}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              display: 'flex',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span>{appName}</span>
            {appVisibility === 'private' && (
              <span
                title="Private app — visible only to you"
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '1px 6px',
                  borderRadius: 4,
                  background: 'var(--bg)',
                  border: '1px solid var(--line)',
                  color: 'var(--muted)',
                }}
              >
                Private
              </span>
            )}
          </div>
          <div
            style={{
              fontFamily: 'var(--font-serif, "DM Serif Display", serif)',
              fontSize: 20,
              fontWeight: 500,
              color: 'var(--ink)',
              lineHeight: 1.25,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              marginTop: 2,
            }}
            title={title}
          >
            {title}
          </div>
        </div>
        {appSlug && (
          <Link
            to={`/me/a/${appSlug}/run?run=${encodeURIComponent(thread.id)}`}
            data-testid="me-thread-open-full"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: 'var(--accent)',
              textDecoration: 'none',
              padding: '6px 10px',
              borderRadius: 6,
              border: '1px solid var(--line)',
              background: 'var(--bg)',
              flexShrink: 0,
            }}
          >
            Open in full →
          </Link>
        )}
      </header>

      <div
        data-testid="me-thread-body"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '18px 0',
        }}
      >
        <TurnRow role="user" content={<span>{title}</span>} />
        {detailError ? (
          <TurnRow
            role="app"
            content={
              <div
                style={{
                  padding: '10px 12px',
                  border: '1px solid var(--danger, #c44)',
                  borderRadius: 8,
                  background: 'var(--card)',
                  color: 'var(--danger, #c44)',
                  fontSize: 13,
                }}
              >
                {detailError}
              </div>
            }
          />
        ) : detail ? (
          <TurnRow role="app" content={<AppTurnBody run={detail} />} />
        ) : (
          <TurnRow
            role="app"
            content={
              <span style={{ color: 'var(--muted)', fontSize: 13 }}>
                Loading run…
              </span>
            }
          />
        )}
      </div>
    </div>
  );
}

function TurnRow({
  role,
  content,
}: {
  role: 'user' | 'app';
  content: ReactNode;
}) {
  const isUser = role === 'user';
  return (
    <div
      style={{
        display: 'flex',
        gap: 12,
        padding: '8px 24px',
        alignItems: 'flex-start',
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: 8,
          background: isUser ? 'var(--accent-soft)' : 'var(--card)',
          color: isUser ? 'var(--accent)' : 'var(--ink)',
          border: '1px solid var(--line)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.04em',
          flexShrink: 0,
        }}
      >
        {isUser ? 'You' : 'App'}
      </div>
      <div
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 14,
          lineHeight: 1.55,
          color: 'var(--ink)',
          paddingTop: 4,
        }}
      >
        {content}
      </div>
    </div>
  );
}

function AppTurnBody({ run }: { run: MeRunDetail }) {
  if (run.status === 'error') {
    return (
      <div
        style={{
          padding: '10px 12px',
          border: '1px solid var(--danger, #c44)',
          borderRadius: 8,
          background: 'var(--card)',
          color: 'var(--danger, #c44)',
          fontSize: 13,
        }}
      >
        {run.error || 'Run failed.'}
      </div>
    );
  }
  if (run.status === 'running' || run.status === 'pending') {
    return (
      <span style={{ color: 'var(--muted)', fontSize: 13 }}>Running…</span>
    );
  }

  const outputs = run.outputs;
  if (outputs == null) {
    return (
      <span style={{ color: 'var(--muted)', fontSize: 13 }}>No output.</span>
    );
  }

  if (typeof outputs === 'string') {
    return <div style={{ whiteSpace: 'pre-wrap' }}>{outputs}</div>;
  }

  if (typeof outputs === 'object') {
    const record = outputs as Record<string, unknown>;
    const text =
      (typeof record['text'] === 'string' && record['text']) ||
      (typeof record['result'] === 'string' && record['result']) ||
      (typeof record['output'] === 'string' && record['output']) ||
      null;
    if (text) return <div style={{ whiteSpace: 'pre-wrap' }}>{text}</div>;
  }

  let pretty: string;
  try {
    pretty = JSON.stringify(outputs, null, 2);
  } catch {
    pretty = String(outputs);
  }
  return (
    <pre
      style={{
        margin: 0,
        padding: '10px 12px',
        border: '1px solid var(--line)',
        borderRadius: 8,
        background: 'var(--card)',
        fontFamily:
          'var(--font-mono, "JetBrains Mono", ui-monospace, Menlo, monospace)',
        fontSize: 12,
        lineHeight: 1.5,
        overflow: 'auto',
        maxHeight: 320,
        whiteSpace: 'pre-wrap',
        color: 'var(--ink)',
      }}
    >
      {pretty}
    </pre>
  );
}
