import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

const DOCKER_CMD = `docker run -d --name floom \\
  -p 3051:3051 \\
  -v floom_data:/data \\
  -v "$(pwd)/apps.yaml:/app/config/apps.yaml:ro" \\
  -e FLOOM_APPS_CONFIG=/app/config/apps.yaml \\
  ghcr.io/floomhq/floom-monorepo:v0.4.0-minimal.6`;

const TERMINAL_LINES = [
  '$ docker run -d --name floom ...',
  '[floom] booting v0.4.0-minimal.6',
  '[floom] reading /app/config/apps.yaml',
  '[floom] ingesting proxied + hosted app specs',
  '[floom] surfaces ready: /apps  /p/:slug  /api/:slug/run  /mcp/app/:slug',
  '[floom] auth, feedback, reviews, secrets, and app memory online',
  '[floom] ready -> http://localhost:3051',
];

export function SelfHostTerminal() {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    try {
      navigator.clipboard.writeText(DOCKER_CMD).catch(() => {});
    } catch {
      // ignore clipboard errors
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div
      style={{
        background: 'var(--terminal-bg, #0e0e0c)',
        color: 'var(--terminal-ink, #f1efe9)',
        borderRadius: 10,
        border: '1px solid rgba(255,255,255,0.08)',
        overflow: 'hidden',
        boxShadow: '0 20px 48px rgba(14,14,12,0.18)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 14px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
          background: 'rgba(255,255,255,0.03)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            <span style={trafficLight('#fb7185')} />
            <span style={trafficLight('#fbbf24')} />
            <span style={trafficLight('#4ade80')} />
          </div>
          <span
            style={{
              fontFamily: 'JetBrains Mono, monospace',
              fontSize: 11,
              color: 'rgba(255,255,255,0.6)',
            }}
          >
            self-host quickstart
          </span>
        </div>
        <button
          type="button"
          onClick={copy}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            background: 'rgba(255,255,255,0.08)',
            border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 8,
            color: copied ? '#86efac' : 'rgba(255,255,255,0.8)',
            fontSize: 12,
            padding: '7px 10px',
          }}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>

      <div style={{ padding: '18px 18px 20px' }}>
        <pre
          style={{
            margin: '0 0 18px',
            whiteSpace: 'pre-wrap',
            overflowX: 'auto',
            fontFamily: 'JetBrains Mono, monospace',
            fontSize: 12.5,
            lineHeight: 1.7,
            color: 'var(--terminal-ink, #f1efe9)',
          }}
        >
          {DOCKER_CMD}
        </pre>

        <div
          style={{
            display: 'grid',
            gap: 8,
            paddingTop: 18,
            borderTop: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          {TERMINAL_LINES.map((line, index) => (
            <div
              key={line}
              style={{
                fontFamily: 'JetBrains Mono, monospace',
                fontSize: 12,
                lineHeight: 1.6,
                color: index === TERMINAL_LINES.length - 1 ? '#86efac' : 'rgba(241,239,233,0.8)',
              }}
            >
              {line}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function trafficLight(color: string) {
  return {
    width: 9,
    height: 9,
    borderRadius: '50%',
    background: color,
    display: 'inline-block',
  } as const;
}
