export interface SecretsCalloutProps {
  secrets: string[];
}

export function SecretsCallout({ secrets }: SecretsCalloutProps) {
  if (secrets.length === 0) return null;

  return (
    <div 
      data-testid="secrets-callout"
      style={{
        margin: '20px 20px 0',
        padding: '16px',
        background: 'var(--card)',
        borderRadius: 10,
        border: '1px solid var(--line)',
        boxShadow: '0 2px 8px rgba(0,0,0,0.03)'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div style={{ 
          width: 24, height: 24, borderRadius: 6, background: 'var(--accent)', 
          display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white'
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
        </div>
        <h4 style={{ margin: 0, fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
          Detected secrets needed
        </h4>
      </div>
      <p style={{ margin: '0 0 12px', fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
        When users run your app, they'll be prompted to provide these keys. You can also provide
        your own keys in the Studio after publishing.
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {secrets.map((s) => (
          <span
            key={s}
            style={{
              padding: '4px 10px',
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'JetBrains Mono, monospace',
              color: 'var(--ink)'
            }}
          >
            {s}
          </span>
        ))}
      </div>
    </div>
  );
}
