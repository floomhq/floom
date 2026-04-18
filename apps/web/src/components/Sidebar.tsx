import { useState } from 'react';
import type { AppDetail } from '../lib/types';
import { AppIcon } from './AppIcon';

const PUBLIC_URL = 'https://preview.floom.dev';

interface Props {
  app: AppDetail | null;
  open: boolean;
  onClose: () => void;
}

export function Sidebar({ app, open, onClose }: Props) {
  if (!open || !app) return null;

  const actions = Object.entries(app.manifest?.actions ?? {});
  const secrets = app.manifest?.secrets_needed ?? [];

  return (
    <>
      <div className="sidebar-backdrop" onClick={onClose} aria-hidden="true" />
      <aside className="sidebar" role="dialog" aria-label={`${app.name} details`}>
        <div className="sidebar-inner" style={{ position: 'relative' }}>
          <button
            type="button"
            className="sidebar-close"
            onClick={onClose}
            title="Close sidebar"
            aria-label="Close"
          >
            <svg
              viewBox="0 0 24 24"
              width={16}
              height={16}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M6 6l12 12M6 18L18 6" />
            </svg>
          </button>

          {/* Header */}
          <div className="sidebar-app-header">
            <div className="sidebar-app-icon">
              <AppIcon slug={app.slug} size={26} />
            </div>
            <div>
              <p className="sidebar-app-name">{app.name}</p>
              <p className="sidebar-app-creator">
                {app.author_display || app.author || '@floomhq'}
              </p>
              {app.category && <span className="category-pill">{app.category}</span>}
            </div>
          </div>
          <p className="sidebar-app-desc">{app.description}</p>

          <div className="divider" />

          {/* Actions */}
          <div className="sidebar-section">
            <p className="sidebar-section-label">Actions</p>
            <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
              {actions.map(([name, spec]) => (
                <li
                  key={name}
                  style={{
                    fontSize: 13,
                    color: 'var(--ink)',
                    padding: '6px 0',
                    borderBottom: '1px solid var(--line)',
                  }}
                >
                  <span style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
                    {name}
                  </span>{' '}
                  : {spec.label}
                </li>
              ))}
            </ul>
          </div>

          <div className="divider" />

          {/* Secrets */}
          <div className="sidebar-section">
            <p className="sidebar-section-label">Secrets</p>
            {secrets.length === 0 ? (
              <p className="sidebar-note">No secrets required.</p>
            ) : (
              <>
                {secrets.map((name) => (
                  <div
                    key={name}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      fontSize: 14,
                      marginBottom: 6,
                    }}
                  >
                    <span className="green-dot" />
                    <span
                      style={{
                        fontFamily: "'JetBrains Mono', monospace",
                        fontSize: 12,
                        color: 'var(--ink)',
                      }}
                    >
                      {name}
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--success)' }}>configured</span>
                  </div>
                ))}
                <p className="sidebar-note">Floom manages these. Bring your own to lift limits.</p>
              </>
            )}
          </div>

          <div className="divider" />

          {/* MCP + HTTP integration cards */}
          <div className="sidebar-section">
            <p className="sidebar-section-label">Use this app from anywhere</p>
            <IntegrationRow
              label="MCP server"
              value={`${PUBLIC_URL}/mcp/app/${app.slug}`}
              hint="Paste into Claude Desktop or Cursor."
              copyable
            />
            <IntegrationRow
              label="HTTP POST"
              value={`POST ${PUBLIC_URL}/api/run  { app_slug: "${app.slug}", inputs: {...} }`}
              hint="cURL-friendly. Returns a run_id; stream via SSE."
              copyable
            />
          </div>
        </div>
      </aside>
    </>
  );
}

function IntegrationRow({
  label,
  value,
  hint,
  copyable,
}: {
  label: string;
  value: string;
  hint: string;
  copyable?: boolean;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <p
          style={{
            fontSize: 12,
            fontWeight: 600,
            color: 'var(--ink)',
            margin: 0,
          }}
        >
          {label}
        </p>
        {copyable && (
          <button
            type="button"
            onClick={handleCopy}
            style={{
              fontSize: 11,
              color: copied ? 'var(--success)' : 'var(--muted)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              fontFamily: 'inherit',
              padding: '2px 6px',
              borderRadius: 4,
              transition: 'color 0.15s',
            }}
          >
            {copied ? 'Copied!' : 'Copy'}
          </button>
        )}
      </div>
      <code
        style={{
          display: 'block',
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          padding: '6px 10px',
          borderRadius: 6,
          wordBreak: 'break-all',
        }}
      >
        {value}
      </code>
      <p style={{ fontSize: 11, color: 'var(--muted)', margin: '4px 0 0' }}>{hint}</p>
    </div>
  );
}
