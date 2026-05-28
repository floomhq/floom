import { redirect } from "next/navigation";
import Link from "next/link";
import { readSession } from "@/lib/session";
import { API_BASE } from "@/lib/api";
import { SignOutButton } from "./SignOutButton";

export const dynamic = "force-dynamic";

type WorkersResponse = { workers?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>;

async function fetchWorkerCount(accessToken: string | null): Promise<number | null> {
  if (!accessToken) return null;
  try {
    const res = await fetch(`${API_BASE}/api/workers`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data: WorkersResponse = await res.json();
    const list = Array.isArray(data) ? data : data?.workers ?? [];
    return list.length;
  } catch {
    return null;
  }
}

export default async function AppPage() {
  const session = await readSession();
  if (!session) {
    redirect("/");
  }

  const workerCount = await fetchWorkerCount(session.accessToken);

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "grid",
        placeItems: "center",
        padding: "48px 24px",
        fontFamily:
          "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
        color: "#0d0d0d",
      }}
    >
      <section
        style={{
          width: "100%",
          maxWidth: 560,
          background: "#fff",
          border: "1px solid rgba(15,15,15,0.08)",
          borderRadius: 16,
          padding: 32,
          boxShadow: "0 1px 0 rgba(15,15,15,0.04), 0 12px 40px rgba(15,15,15,0.06)",
        }}
      >
        <div
          style={{
            fontSize: 12,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            color: "#6b6b6b",
            marginBottom: 12,
          }}
        >
          Workspace
        </div>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: "0 0 4px", lineHeight: 1.25 }}>
          Welcome back
        </h1>
        <p style={{ fontSize: 14, color: "#5b5b5b", margin: "0 0 28px" }}>
          Signed in as <strong style={{ color: "#0d0d0d" }}>{session.email ?? "—"}</strong>
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 12,
            marginBottom: 28,
          }}
        >
          <div
            style={{
              border: "1px solid rgba(15,15,15,0.08)",
              borderRadius: 10,
              padding: 14,
            }}
          >
            <div style={{ fontSize: 11, color: "#6b6b6b", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Workers
            </div>
            <div style={{ fontSize: 22, fontWeight: 600, marginTop: 6 }}>
              {workerCount ?? "—"}
            </div>
          </div>
          <div
            style={{
              border: "1px solid rgba(15,15,15,0.08)",
              borderRadius: 10,
              padding: 14,
            }}
          >
            <div style={{ fontSize: 11, color: "#6b6b6b", textTransform: "uppercase", letterSpacing: "0.06em" }}>
              Plan
            </div>
            <div style={{ fontSize: 22, fontWeight: 600, marginTop: 6 }}>free</div>
          </div>
        </div>

        <p style={{ fontSize: 13, color: "#5b5b5b", margin: "0 0 20px", lineHeight: 1.5 }}>
          You&apos;re signed in to the Workeros cloud. The dashboard is minimal for now —
          create workers via the MCP server or the CLI:
        </p>
        <pre
          style={{
            background: "#0d0d0d",
            color: "#e8e8e8",
            padding: "12px 14px",
            borderRadius: 8,
            fontSize: 13,
            margin: "0 0 24px",
            overflowX: "auto",
            fontFamily:
              "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
          }}
        >
          npx -y @floomhq/workeros-mcp
        </pre>

        <div style={{ display: "flex", gap: 12, alignItems: "center", justifyContent: "space-between" }}>
          <Link
            href="/"
            style={{
              fontSize: 13,
              color: "#5b5b5b",
              textDecoration: "none",
            }}
          >
            ← Back to landing
          </Link>
          <SignOutButton />
        </div>
      </section>
    </main>
  );
}
