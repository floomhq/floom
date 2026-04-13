import { useState } from 'react';

export function BuildYourOwnResponse() {
  const [url, setUrl] = useState('');

  return (
    <div className="assistant-turn">
      <div className="app-expanded-card">
        <p style={{ margin: '0 0 16px', fontSize: 15, lineHeight: 1.6 }}>
          Floom turns any GitHub repo into a runnable agent-callable tool via a 5-line manifest.
          Paste a GitHub URL below and Floom will auto-detect the runtime, generate a{' '}
          <code
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
              background: 'var(--bg)',
              padding: '1px 5px',
              borderRadius: 4,
              border: '1px solid var(--line)',
            }}
          >
            floom.yaml
          </code>
          , and deploy it in 10 seconds.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://github.com/owner/repo"
            style={{
              flex: 1,
              height: 40,
              borderRadius: 8,
              border: '1px solid var(--line)',
              background: 'var(--bg)',
              padding: '0 12px',
              fontFamily: 'inherit',
              fontSize: 14,
              color: 'var(--ink)',
              outline: 'none',
            }}
          />
          <button
            type="button"
            style={{
              height: 40,
              padding: '0 16px',
              background: 'var(--accent)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              fontWeight: 600,
              fontSize: 14,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
            onClick={() => {
              if (url.trim()) {
                // Stub: future integration point
                window.open(url.trim(), '_blank');
              }
            }}
          >
            Deploy
          </button>
        </div>
      </div>
    </div>
  );
}
