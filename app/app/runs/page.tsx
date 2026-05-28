import Link from "next/link";
import { apiGetJson } from "@/lib/api-server";

export const dynamic = "force-dynamic";

type Run = {
  id: string;
  worker_id?: string;
  status?: string;
  trigger_source?: string;
  created_at?: string;
};

function fmtTime(iso: string | undefined): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
  } catch {
    return iso;
  }
}

const statusColor = (status?: string) => {
  switch (status) {
    case "success":
    case "completed":
      return "#0a8a3a";
    case "running":
    case "queued":
      return "#0040c0";
    case "error":
    case "failed":
      return "#c0001a";
    default:
      return "#6b6b6b";
  }
};

export default async function RunsPage() {
  const runs = (await apiGetJson<Run[]>("/api/runs")) ?? [];

  return (
    <section>
      <header style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#6b6b6b" }}>Workspace</div>
          <h1 style={{ fontSize: 24, fontWeight: 600, margin: "4px 0 0" }}>Runs</h1>
        </div>
        <div style={{ fontSize: 13, color: "#6b6b6b" }}>{runs.length} total</div>
      </header>

      {runs.length === 0 ? (
        <div style={{
          border: "1px dashed rgba(15,15,15,0.16)",
          borderRadius: 14,
          padding: 32,
          textAlign: "center",
          background: "rgba(15,15,15,0.02)",
        }}>
          <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 6 }}>No runs yet</div>
          <p style={{ fontSize: 14, color: "#5b5b5b", margin: 0 }}>
            Once you create a worker and it runs (via cron, webhook, or manual trigger), runs show up here.
          </p>
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 6 }}>
          {runs.map((r) => (
            <li
              key={r.id}
              style={{
                border: "1px solid rgba(15,15,15,0.08)",
                borderRadius: 10,
                padding: "12px 16px",
                background: "#fff",
                display: "grid",
                gridTemplateColumns: "1fr auto auto auto",
                alignItems: "center",
                gap: 16,
                fontSize: 13,
              }}
            >
              <span style={{ fontWeight: 600 }}>{r.worker_id ?? "—"}</span>
              <span style={{ color: "#6b6b6b" }}>{r.trigger_source ?? "—"}</span>
              <span style={{ color: statusColor(r.status), fontWeight: 500 }}>{r.status ?? "—"}</span>
              <span style={{ color: "#6b6b6b", fontSize: 12 }}>{fmtTime(r.created_at)}</span>
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
