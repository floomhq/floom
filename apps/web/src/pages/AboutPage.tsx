import { Link } from 'react-router-dom';
import { TopBar } from '../components/TopBar';

export function AboutPage() {
  return (
    <div className="page-root">
      <TopBar />
      <main className="main" style={{ maxWidth: 720, paddingTop: 72, paddingBottom: 120 }}>
        <h1 className="headline" style={{ fontSize: 44 }}>
          Floom is infra for agentic work.
        </h1>
        <p className="subhead" style={{ fontSize: 17 }}>
          One manifest. Every agent surface. Any CLI, MCP server, or Python library becomes a
          chat, a tool call, and an HTTP endpoint in 10 seconds.
        </p>

        <div className="divider" />

        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em' }}>
            One manifest, four surfaces
          </h2>
          <p style={{ color: 'var(--muted)' }}>
            A tool becomes a Floom app by providing a <code>floom.yaml</code> manifest. From that
            single file, Floom auto-generates four equivalent interfaces:
          </p>
          <ul style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
            <li>
              <strong>Chat UI</strong> — this site. A prompt box that picks the right app and runs
              it.
            </li>
            <li>
              <strong>MCP server</strong> — an MCP-compliant HTTP+SSE endpoint any agent can call.
            </li>
            <li>
              <strong>HTTP API</strong> — a REST endpoint any HTTP client can call.
            </li>
            <li>
              <strong>CLI tool</strong> — <code>floom run {'{slug}'} --input=value</code> via the
              Floom CLI (roadmap).
            </li>
          </ul>
          <p style={{ color: 'var(--muted)' }}>
            All four surfaces call the same sandbox. The manifest is the source of truth.
          </p>
        </section>

        <div className="divider" />

        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em' }}>
            What's live right now
          </h2>
          <ul style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
            <li>
              <Link to="/browse">15 apps</Link> runnable via chat, MCP, and HTTP.
            </li>
            <li>Docker-per-app runner with hard timeouts and memory caps.</li>
            <li>GPT-4o-mini parser that turns prose into structured inputs.</li>
            <li>Semantic app picker using OpenAI embeddings.</li>
            <li>Per-app MCP endpoints at <code>/mcp/app/{'{slug}'}</code>.</li>
          </ul>
        </section>

        <div className="divider" />

        <section style={{ marginTop: 24 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.01em' }}>Roadmap</h2>
          <ul style={{ color: 'var(--muted)', lineHeight: 1.8 }}>
            <li>e2b sandbox runtime with 611ms warm starts (v2, in flight).</li>
            <li>Floom CLI for local <code>floom run</code> / <code>floom deploy</code>.</li>
            <li>
              <Link to="/">Thread persistence</Link> across devices.
            </li>
            <li>Public app directory + inbox of run results.</li>
          </ul>
        </section>

        <p
          style={{
            marginTop: 48,
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 11,
            color: 'var(--muted)',
          }}
        >
          Built in Hamburg by Federico De Ponte and contributors. MIT licensed. See{' '}
          <a href="https://github.com/federicodeponte/floom-chat" target="_blank" rel="noreferrer">
            the repo
          </a>{' '}
          for the full spec.
        </p>
      </main>
    </div>
  );
}
