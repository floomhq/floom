import Link from "next/link";
import { OAUTH_LOGIN_URL, OAUTH_LOGIN_URL_GITHUB } from "@/lib/api";

export const metadata = {
  title: "Sign in — Workeros",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string }>;
}) {
  // Next 16: searchParams is ALWAYS a Promise in server components. The
  // previous ternary that checked for "then" always picked the non-Promise
  // branch and lost the next param. Awaiting handles undefined too.
  const sp = (await searchParams) ?? {};
  const next = sp.next ?? "/app";

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
          maxWidth: 380,
          background: "#fff",
          border: "1px solid rgba(15,15,15,0.08)",
          borderRadius: 16,
          padding: "36px 32px",
          boxShadow: "0 1px 0 rgba(15,15,15,0.04), 0 12px 40px rgba(15,15,15,0.06)",
          textAlign: "center",
        }}
      >
        <Link href="/" style={{ color: "#0d0d0d", textDecoration: "none", fontWeight: 600, fontSize: 14 }}>
          Workeros
        </Link>
        <h1 style={{ fontSize: 22, fontWeight: 600, margin: "20px 0 6px", lineHeight: 1.25 }}>
          Sign in
        </h1>
        <p style={{ fontSize: 13, color: "#5b5b5b", margin: "0 0 24px" }}>
          Continue to your workspace
        </p>

        <div style={{ display: "grid", gap: 10 }}>
          <a href={OAUTH_LOGIN_URL(next)} style={primaryButton}>
            <GoogleIcon />
            Continue with Google
          </a>
          <a href={OAUTH_LOGIN_URL_GITHUB(next)} style={secondaryButton}>
            <GitHubIcon />
            Continue with GitHub
          </a>
        </div>

        <p style={{ fontSize: 12, color: "#8b8b8b", margin: "28px 0 0", lineHeight: 1.5 }}>
          By signing in you agree to the Workeros terms. We&apos;ll create your workspace
          automatically on first sign-in.
        </p>
      </section>
    </main>
  );
}

const primaryButton = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  height: 44,
  borderRadius: 8,
  background: "#0d0d0d",
  color: "#fff",
  textDecoration: "none",
  fontSize: 14,
  fontWeight: 500,
  border: "1px solid #0d0d0d",
} as const;

const secondaryButton = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 10,
  height: 44,
  borderRadius: 8,
  background: "#fff",
  color: "#0d0d0d",
  textDecoration: "none",
  fontSize: 14,
  fontWeight: 500,
  border: "1px solid rgba(15,15,15,0.16)",
} as const;

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path
        d="M21.6 12.227c0-.78-.07-1.53-.2-2.25H12v4.255h5.39a4.6 4.6 0 0 1-2 3.025v2.515h3.23c1.89-1.74 2.98-4.3 2.98-7.545z"
        fill="#4285F4"
      />
      <path
        d="M12 22c2.7 0 4.965-.895 6.62-2.428l-3.23-2.515c-.895.6-2.04.955-3.39.955-2.605 0-4.81-1.76-5.6-4.125H3.07v2.595A10 10 0 0 0 12 22z"
        fill="#34A853"
      />
      <path
        d="M6.4 13.887A6 6 0 0 1 6.085 12c0-.655.11-1.295.315-1.887V7.518H3.07A10 10 0 0 0 2 12c0 1.615.385 3.145 1.07 4.482L6.4 13.887z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.99c1.47 0 2.785.505 3.823 1.498l2.865-2.866C16.96 2.99 14.695 2 12 2 8.115 2 4.755 4.225 3.07 7.518L6.4 10.113C7.19 7.748 9.395 5.99 12 5.99z"
        fill="#EA4335"
      />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true">
      <path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.3-1.8-1.3-1.8-1.1-.7.1-.7.1-.7 1.2 0 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.7-.3-5.5-1.3-5.5-5.9 0-1.3.5-2.4 1.2-3.2 0-.4-.5-1.6.2-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0c2.3-1.5 3.3-1.2 3.3-1.2.7 1.6.2 2.8.1 3.2.8.8 1.2 1.9 1.2 3.2 0 4.6-2.8 5.6-5.5 5.9.4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3" />
    </svg>
  );
}
