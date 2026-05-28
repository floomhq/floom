import Link from "next/link";
import { redirect } from "next/navigation";
import { readSession } from "@/lib/session";
import { SignOutButton } from "./SignOutButton";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await readSession();
  if (!session) redirect("/");

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif" }}>
      <header
        style={{
          borderBottom: "1px solid rgba(15,15,15,0.08)",
          background: "rgba(255,255,255,0.92)",
          backdropFilter: "saturate(150%) blur(8px)",
          position: "sticky",
          top: 0,
          zIndex: 10,
        }}
      >
        <nav
          style={{
            maxWidth: 1100,
            margin: "0 auto",
            padding: "12px 24px",
            display: "flex",
            alignItems: "center",
            gap: 20,
          }}
        >
          <Link href="/app" style={{ fontWeight: 600, fontSize: 14, color: "#0d0d0d", textDecoration: "none" }}>
            Workeros
          </Link>
          <div style={{ display: "flex", gap: 16, flex: 1 }}>
            <Link href="/app/workers" style={navLink}>Workers</Link>
            <Link href="/app/runs" style={navLink}>Runs</Link>
            <Link href="/app/connections" style={navLink}>Connections</Link>
          </div>
          <span style={{ fontSize: 13, color: "#5b5b5b" }}>{session.email}</span>
          <SignOutButton />
        </nav>
      </header>
      <main style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 24px", width: "100%", flex: 1 }}>
        {children}
      </main>
    </div>
  );
}

const navLink = {
  fontSize: 13,
  color: "#5b5b5b",
  textDecoration: "none",
  fontFamily: "inherit",
} as const;
