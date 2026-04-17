import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import { LAUNCH_APPS } from '../../data/demoData';

export interface LaunchStripItem {
  slug: string;
  name: string;
  category: string | null;
  tagline: string;
  blockedReason?: string | null;
}

interface Props {
  apps?: LaunchStripItem[];
}

export function LaunchAppsStrip({ apps = LAUNCH_APPS }: Props) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-end',
          gap: 16,
          flexWrap: 'wrap',
        }}
      >
        <div>
          <p className="label-mono" style={{ margin: '0 0 8px' }}>
            Live preview catalog
          </p>
          <p
            style={{
              margin: 0,
              fontSize: 14,
              color: 'var(--muted)',
              lineHeight: 1.6,
              maxWidth: 520,
            }}
          >
            Real apps from the current hub, surfaced the same way users find them in the store.
          </p>
        </div>
        <Link
          to="/apps"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 13,
            fontWeight: 600,
            color: 'var(--ink)',
            textDecoration: 'none',
          }}
        >
          Browse the store <ArrowRight size={13} />
        </Link>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
        }}
      >
        {apps.slice(0, 8).map((app) => (
          <Link
            key={app.slug}
            to={`/p/${app.slug}`}
            style={{
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              padding: '16px 15px',
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
              minHeight: 168,
              textDecoration: 'none',
              color: 'inherit',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                gap: 10,
              }}
            >
              <div>
                <p
                  style={{
                    margin: '0 0 4px',
                    fontSize: 15,
                    fontWeight: 700,
                    color: 'var(--ink)',
                  }}
                >
                  {app.name}
                </p>
                <p
                  style={{
                    margin: 0,
                    fontFamily: 'JetBrains Mono, monospace',
                    fontSize: 11,
                    color: 'var(--muted)',
                    textTransform: 'lowercase',
                  }}
                >
                  {app.category || 'utility'}
                </p>
              </div>
              <span
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 999,
                  border: '1px solid var(--line)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--muted)',
                  flexShrink: 0,
                }}
              >
                <ArrowRight size={13} />
              </span>
            </div>

            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: 'var(--muted)',
                lineHeight: 1.6,
              }}
            >
              {app.tagline}
            </p>

            <div style={{ marginTop: 'auto' }}>
              {app.blockedReason ? (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '6px 9px',
                    borderRadius: 999,
                    background: '#fff7ed',
                    color: '#9a3412',
                    border: '1px solid #fed7aa',
                    fontSize: 11,
                    fontWeight: 600,
                    lineHeight: 1,
                  }}
                  title={app.blockedReason}
                >
                  hosted-mode only
                </span>
              ) : (
                <span
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    padding: '6px 9px',
                    borderRadius: 999,
                    background: 'var(--accent-soft)',
                    color: 'var(--accent-hover)',
                    border: '1px solid var(--accent-border)',
                    fontSize: 11,
                    fontWeight: 600,
                    lineHeight: 1,
                  }}
                >
                  open
                </span>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
