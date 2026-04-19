export function TrustStrip() {
  return (
    <div className="trust-strip">
      <p className="trust-strip-label">Works great with</p>
      <div className="trust-logos">
        <div className="trust-logo-item">
          <svg width={18} height={18} viewBox="0 0 24 24">
            <use href="#icon-anthropic" fill="currentColor" />
          </svg>
          <span>Anthropic</span>
        </div>
        <div className="trust-logo-item">
          <svg width={18} height={18} viewBox="0 0 24 24">
            <use href="#icon-cursor" fill="currentColor" />
          </svg>
          <span>Cursor</span>
        </div>
        <div className="trust-logo-item">
          <svg width={18} height={18} viewBox="0 0 24 24">
            <use href="#icon-windsurf" stroke="currentColor" fill="none" />
          </svg>
          <span>Windsurf</span>
        </div>
        <div className="trust-logo-item">
          <svg width={18} height={18} viewBox="0 0 24 24">
            <use href="#icon-continue" stroke="currentColor" fill="none" />
          </svg>
          <span>Continue</span>
        </div>
      </div>
      <p
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 11,
          color: 'var(--muted)',
          marginTop: 32,
        }}
      >
        Built in SF by Federico De Ponte and contributors.{' '}
        <a
          href="https://github.com/floomhq/floom-monorepo"
          target="_blank"
          rel="noreferrer"
          style={{ color: 'inherit', textDecoration: 'underline' }}
        >
          Open source on GitHub.
        </a>
      </p>
    </div>
  );
}
