export function AboutFloomResponse() {
  return (
    <div className="assistant-turn">
      <div className="app-expanded-card">
        <p style={{ margin: '0 0 14px', fontSize: 15, lineHeight: 1.7 }}>
          Floom is infra for agentic work. One manifest, four surfaces: every Floom app gets a chat
          UI, an MCP server, an HTTP endpoint, and a CLI command from a single 5-line manifest. v1
          runs on Docker, v2 migrates to e2b. Built in Hamburg by Federico De Ponte and contributors.
        </p>
        <a
          href="https://github.com/floomhq/floom"
          target="_blank"
          rel="noreferrer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 14,
            color: 'var(--accent)',
            fontWeight: 500,
          }}
        >
          View source →
        </a>
      </div>
    </div>
  );
}
