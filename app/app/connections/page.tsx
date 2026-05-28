import Link from "next/link";
import { apiGetJson } from "@/lib/api-server";

export const dynamic = "force-dynamic";

type Connection = {
  id: string;
  app?: string;
  display_name?: string;
  status?: string;
  created_at?: string;
};

export default async function ConnectionsPage() {
  const connections = (await apiGetJson<Connection[]>("/api/connections")) ?? [];

  return (
    <section>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b6b6b" }}>Workspace</div>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: "4px 0 0" }}>Connections</h1>
        </div>
        <div style={{ fontSize: 13, color: "#6b6b6b" }}>{connections.length} total</div>
      </header>

      {connections.length === 0 ? (
        <div style={{
          border: "1px dashed rgba(15,15,15,0.16)",
          borderRadius: 14,
          padding: 32,
          textAlign: "center",
          background: "rgba(15,15,15,0.02)",
        }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>No connections yet</div>
          <p style={{ fontSize: 14, color: "#5b5b5b", margin: 0, lineHeight: 1.5 }}>
            Workers connect to services (Gmail, Slack, Notion, etc.) via Composio. Add a connection
            from a worker that declares it in <code style={{ background: "rgba(15,15,15,0.06)", padding: "1px 6px", borderRadius: 4 }}>worker.yml</code>.
          </p>
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
          {connections.map((c) => (
            <li
              key={c.id}
              style={{
                border: "1px solid rgba(15,15,15,0.08)",
                borderRadius: 10,
                padding: "14px 18px",
                background: "#fff",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                fontSize: 14,
              }}
            >
              <div>
                <div style={{ fontWeight: 600 }}>{c.app ?? "—"}</div>
                {c.display_name && <div style={{ fontSize: 13, color: "#6b6b6b" }}>{c.display_name}</div>}
              </div>
              <span style={{ fontSize: 12, color: c.status === "live" ? "#0a8a3a" : "#6b6b6b" }}>{c.status ?? "—"}</span>
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
