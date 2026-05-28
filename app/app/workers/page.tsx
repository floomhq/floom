import Link from "next/link";
import { apiGetJson } from "@/lib/api-server";

export const dynamic = "force-dynamic";

type Worker = {
  id: string;
  name?: string;
  status?: string;
  description?: string;
  last_run?: { status?: string; created_at?: string } | null;
};

export default async function WorkersPage() {
  const workers = (await apiGetJson<Worker[]>("/api/workers")) ?? [];

  return (
    <section>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={eyebrow}>Workspace</div>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: "4px 0 0" }}>Workers</h1>
        </div>
        <div style={{ fontSize: 13, color: "#6b6b6b" }}>{workers.length} total</div>
      </header>

      {workers.length === 0 ? (
        <EmptyState
          title="No workers yet"
          body="Create your first worker via the MCP server. Drive it from Claude, Cursor, or any MCP-capable agent."
        />
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
          {workers.map((w) => (
            <li key={w.id} style={rowCard}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 15 }}>{w.name ?? w.id}</div>
                  {w.description && <div style={{ fontSize: 13, color: "#6b6b6b", marginTop: 2 }}>{w.description}</div>}
                </div>
                <div style={{ fontSize: 12, color: "#6b6b6b" }}>{w.status ?? "—"}</div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <p style={{ fontSize: 13, color: "#6b6b6b", marginTop: 24 }}>
        ← <Link href="/app" style={{ color: "#0d0d0d" }}>Back to overview</Link>
      </p>
    </section>
  );
}

const eyebrow = {
  fontSize: 11,
  textTransform: "uppercase" as const,
  letterSpacing: "0.08em",
  color: "#6b6b6b",
};

const rowCard = {
  border: "1px solid rgba(15,15,15,0.08)",
  borderRadius: 10,
  padding: "14px 18px",
  background: "#fff",
};

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div
      style={{
        border: "1px dashed rgba(15,15,15,0.16)",
        borderRadius: 14,
        padding: 32,
        textAlign: "center",
        background: "rgba(15,15,15,0.02)",
      }}
    >
      <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>{title}</div>
      <p style={{ fontSize: 14, color: "#5b5b5b", margin: "0 auto 16px", maxWidth: 460, lineHeight: 1.5 }}>{body}</p>
      <pre style={preBlack}>npx -y @floomhq/workeros</pre>
    </div>
  );
}

const preBlack = {
  background: "#0d0d0d",
  color: "#e8e8e8",
  padding: "10px 14px",
  borderRadius: 8,
  fontSize: 13,
  margin: "0 auto",
  display: "inline-block",
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
};
