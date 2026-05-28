import Link from "next/link";
import { readSession } from "@/lib/session";
import { apiGetJson } from "@/lib/api-server";

export const dynamic = "force-dynamic";

type Counts = { workers: number | null; runs: number | null; connections: number | null };

async function fetchCounts(): Promise<Counts> {
  const [workers, runs, connections] = await Promise.all([
    apiGetJson<unknown[]>("/api/workers"),
    apiGetJson<unknown[]>("/api/runs"),
    apiGetJson<unknown[]>("/api/connections"),
  ]);
  return {
    workers: workers ? workers.length : null,
    runs: runs ? runs.length : null,
    connections: connections ? connections.length : null,
  };
}

export default async function AppPage() {
  const session = await readSession();
  const counts = await fetchCounts();

  return (
    <section style={{ display: "grid", gap: 24 }}>
      <div>
        <div style={eyebrow}>Workspace</div>
        <h1 style={{ fontSize: 28, fontWeight: 600, margin: "4px 0 4px", lineHeight: 1.2 }}>
          Welcome back
        </h1>
        <p style={{ fontSize: 14, color: "#5b5b5b", margin: 0 }}>
          Signed in as <strong style={{ color: "#0d0d0d" }}>{session?.email ?? "—"}</strong> · Free plan
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12 }}>
        <StatTile label="Workers" value={counts.workers} href="/app/workers" />
        <StatTile label="Runs" value={counts.runs} href="/app/runs" />
        <StatTile label="Connections" value={counts.connections} href="/app/connections" />
      </div>

      <div style={card}>
        <div style={eyebrow}>Get started</div>
        <h2 style={{ fontSize: 18, fontWeight: 600, margin: "4px 0 12px" }}>
          Create your first worker
        </h2>
        <p style={{ fontSize: 14, color: "#5b5b5b", margin: "0 0 16px", lineHeight: 1.5 }}>
          Workers run inside E2B sandboxes. Drive them from Claude, Cursor, or any MCP-capable
          agent — install the Workeros MCP server:
        </p>
        <pre style={preBlack}>npx -y @floomhq/workeros</pre>
        <p style={{ fontSize: 13, color: "#6b6b6b", margin: "12px 0 0", lineHeight: 1.5 }}>
          Or browse the open-source engine at{" "}
          <a href="https://github.com/floomhq/workeros" style={{ color: "#0d0d0d" }} target="_blank" rel="noopener noreferrer">
            github.com/floomhq/workeros
          </a>
          .
        </p>
      </div>
    </section>
  );
}

const card = {
  border: "1px solid rgba(15,15,15,0.08)",
  borderRadius: 14,
  padding: 24,
  background: "#fff",
} as const;

const eyebrow = {
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: "0.08em",
  color: "#6b6b6b",
};

const preBlack = {
  background: "#0d0d0d",
  color: "#e8e8e8",
  padding: "12px 14px",
  borderRadius: 8,
  fontSize: 13,
  margin: 0,
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
};

function StatTile({ label, value, href }: { label: string; value: number | null; href: string }) {
  return (
    <Link
      href={href}
      style={{
        display: "block",
        ...card,
        padding: 18,
        textDecoration: "none",
        color: "inherit",
        transition: "border-color 0.15s",
      }}
    >
      <div style={eyebrow}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 600, marginTop: 4 }}>{value ?? "—"}</div>
    </Link>
  );
}
