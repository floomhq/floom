import type { ReactNode } from "react";
import Link from "next/link";
import { LoginEmailPanel } from "@/components/LoginEmailPanel";
import { AuthButton } from "@/components/AuthButton";
import { safeAppNext } from "@/lib/safe-next";

export const metadata = {
  title: "Sign in · Floom Workers",
};

// Same-origin proxy keeps PKCE + session cookies on the dashboard host
// (floom.dev/app), not the Railway API subdomain.
const PROXY_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/app/api/proxy";

const oauthLoginUrl = (provider: "google" | "github", next = "/app", switchAccount = false) => {
  const params = new URLSearchParams({
    provider,
    next: safeAppNext(next),
  });
  if (switchAccount) params.set("switch", "1");
  return `${PROXY_BASE}/auth/login?${params.toString()}`;
};

const INSTALL_ROUTES: Record<string, string> = {
  slack: "/app/install/slack",
  whatsapp: "/app/install/whatsapp",
  discord: "/app/install/discord",
  cli: "/app/install/cli",
};

// Illustrative activity data shown pre-auth to demonstrate worker runs.
// No real user data, purely a proof-of-concept showcase that mirrors the
// public /login marketing panel.
const ACTIVITY_ROWS: {
  name: string;
  result: string;
  status: "done" | "running";
  time: string;
  icon: ReactNode;
}[] = [
  { name: "Lead research", result: "14 qualified leads", status: "done", time: "4m ago", icon: <UsersIcon /> },
  { name: "Post-call follow-up", result: "Sent to 3 contacts", status: "done", time: "11m ago", icon: <MailIcon /> },
  { name: "Pipeline report", result: "Gathering data", status: "running", time: "now", icon: <FileTextIcon /> },
  { name: "GitHub Digest", result: "14 PRs summarized", status: "done", time: "22m ago", icon: <GitHubIcon /> },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string; mode?: string; install?: string; switch?: string; error?: string }>;
}) {
  // Next 16: searchParams is always a Promise in server components.
  const sp = (await searchParams) ?? {};
  const install = typeof sp.install === "string" ? sp.install.toLowerCase() : "";
  const next = install && INSTALL_ROUTES[install] ? INSTALL_ROUTES[install] : safeAppNext(sp.next);
  const initialMode = sp.mode === "signup" || sp.mode === "signin" ? sp.mode : "magic";
  const switchAccount = sp.switch === "1" || sp.switch === "true";
  const signupHref = `/login?mode=signup&next=${encodeURIComponent(next)}${install ? `&install=${encodeURIComponent(install)}` : ""}`;
  const errorMessage = authErrorMessage(sp.error);

  return (
    <main
      className="min-h-screen font-sans antialiased"
      style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
    >
      {/* Keyframes for the Running pill dot pulse, scoped to login page */}
      <style>{`
        @keyframes login-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>

      <header className="mx-auto flex h-[64px] w-full max-w-[1000px] items-center px-7">
        <Link
          href="/"
          className="login-focus inline-flex items-center gap-2.5 rounded-[var(--radius-button)] text-[14px] font-semibold transition-opacity hover:opacity-80"
          style={{ color: "var(--ink)" }}
        >
          <FloomMark size={22} />
          Floom
        </Link>
      </header>

      <section
        className="mx-auto grid w-full max-w-[900px] items-center gap-12 px-7 pb-20 pt-12 md:grid-cols-[1fr_360px] md:pt-20"
        aria-labelledby="login-heading"
      >
        <div className="hidden max-w-[460px] md:block">
          <h2
            className="text-[40px] font-semibold leading-[1.04] tracking-[-0.034em]"
            style={{ color: "var(--text-primary)" }}
          >
            <span className="login-hl">Hire</span> AI workers.
          </h2>
          <p
            className="mt-4 max-w-[380px] text-[14px] leading-relaxed"
            style={{ color: "var(--text-muted)" }}
          >
            {install
              ? `Sign in to install ${install} and put it to work.`
              : "Describe the job, review the draft, and keep every worker run on the record."}
          </p>

          <div
            className="mt-7"
            style={{
              background: "var(--bg-card)",
              borderRadius: 18,
              padding: 8,
            }}
          >
            <div
              className="flex items-center justify-between"
              style={{ padding: "10px 12px 11px" }}
            >
              <span
                className="text-[11px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "var(--text-muted)" }}
              >
                Today
              </span>
              <StatusPill status="done" label="6 active" />
            </div>

            {ACTIVITY_ROWS.map((row, i) => (
              <div
                key={row.name}
                className="flex min-h-[52px] items-center gap-3"
                style={{
                  padding: 12,
                  borderTop: i > 0 ? "1px solid rgba(16,17,20,.055)" : undefined,
                }}
              >
                <WorkerRowIcon icon={row.icon} />

                <div className="min-w-0 flex-1">
                  <div
                    className="truncate text-sm font-medium"
                    style={{ color: "var(--text-primary)" }}
                  >
                    {row.name}
                  </div>
                  <div
                    className="mt-0.5 text-xs"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {row.result}
                  </div>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <StatusPill status={row.status} />
                  <span
                    className="text-[11px]"
                    style={{ color: "var(--text-muted)" }}
                  >
                    {row.time}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div
            className="mt-4 flex items-center gap-2 text-[13px]"
            style={{ color: "var(--text-muted)" }}
          >
            142 runs today
            <span
              style={{
                width: 3,
                height: 3,
                borderRadius: "50%",
                background: "#cfc8ba",
                display: "inline-block",
              }}
            />
            0 need attention
            <span
              style={{
                width: 3,
                height: 3,
                borderRadius: "50%",
                background: "#cfc8ba",
                display: "inline-block",
              }}
            />
            avg 38s
          </div>
        </div>

        <div className="w-full">
          <div
            className="rounded-[18px] bg-card p-6"
            style={{
              background: "var(--bg-card)",
            }}
          >
            <div className="mb-6 text-center">
              <h1 id="login-heading" className="text-[21px] font-semibold tracking-[-0.02em]">
                Welcome back
              </h1>
              <p className="mt-1 text-[12.5px] text-muted-foreground">
                {install ? `Install ${install} after signing in.` : "Magic link, password, or OAuth."}
              </p>
            </div>

            {errorMessage ? (
              <div
                className="mb-4 rounded-[12px] px-3 py-2 text-center text-[12px] leading-5"
                style={{ background: "rgba(180,83,9,.10)", color: "var(--warning)" }}
                role="alert"
              >
                {errorMessage}
              </div>
            ) : null}

            <div className="space-y-2.5">
              <AuthButton method="google" href={oauthLoginUrl("google", next, switchAccount)} className="flex h-11 items-center justify-center gap-2 rounded-[12px] bg-foreground px-4 text-[14px] font-medium text-background">
                <GoogleIcon />
                <span>Continue with Google</span>
              </AuthButton>
              <AuthButton method="github" href={oauthLoginUrl("github", next, switchAccount)} className="flex h-11 items-center justify-center gap-2 rounded-[12px] bg-secondary px-4 text-[14px] font-medium text-foreground transition-colors hover:bg-[var(--bg-3)]">
                <GitHubIcon />
                <span>Continue with GitHub</span>
              </AuthButton>
            </div>

            <div className="my-5 text-center">
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                or
              </span>
            </div>

            <LoginEmailPanel next={next} initialMode={initialMode} />

            <p className="mt-6 text-center text-[11.5px] leading-[1.6] text-muted-foreground">
              By signing in you agree to the{" "}
              <Link href="/terms" className="login-focus underline-offset-4 hover:text-foreground hover:underline">
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="login-focus underline-offset-4 hover:text-foreground hover:underline">
                Privacy Policy
              </Link>
              .
            </p>
          </div>

          <p className="mt-5 text-center text-[12px]" style={{ color: "var(--ink-mute)" }}>
            New here?{" "}
            <Link href={signupHref} className="login-focus rounded-[4px] underline underline-offset-2 transition-colors hover:text-[var(--ink)]" style={{ color: "var(--ink-soft)" }}>
              Create an account
            </Link>
          </p>
        </div>
      </section>

      <style>{`
        /* Landing /login uses V3Shell .v3-hl — mirror the blue selection pill here */
        .login-hl {
          background: color-mix(in srgb, var(--accent) 14%, transparent);
          color: var(--accent);
          border-radius: 4px;
          padding: 0 3px;
          font-weight: 500;
        }
        .auth-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 10px;
          height: 44px;
          border-radius: var(--radius-button);
          font-size: 14px;
          font-weight: 500;
          letter-spacing: 0;
          text-decoration: none;
          outline: none;
          transition: background 120ms var(--ease), opacity 120ms var(--ease), color 120ms var(--ease);
        }
        .auth-btn:focus-visible,
        .login-focus:focus-visible {
          outline: none;
          box-shadow: var(--focus);
        }
        .auth-btn-secondary {
          background: var(--bg-2);
          color: var(--ink);
        }
        .auth-btn-secondary:hover {
          background: var(--bg-3);
        }
      `}</style>
    </main>
  );
}

function FloomMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      style={{ borderRadius: "22%", color: "var(--ink)" }}
    >
      <rect width="100" height="100" rx="22" fill="currentColor" />
      <path
        d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
        fill="var(--bg-app)"
      />
    </svg>
  );
}

function WorkerRowIcon({ icon }: { icon: ReactNode }) {
  return (
    <span
      data-login-worker-icon
      className="inline-flex shrink-0 items-center justify-center [&_svg]:h-[13px] [&_svg]:w-[13px]"
      style={{
        width: 20,
        height: 20,
        borderRadius: "var(--radius-squircle)",
        background: "transparent",
        color: "var(--text-primary)",
      }}
      aria-hidden="true"
    >
      {icon}
    </span>
  );
}

function authErrorMessage(error?: string): string | null {
  if (!error) return null;
  if (error === "expired_link") {
    return "This sign-in link expired or was already used. Request a new one below.";
  }
  if (error === "account_disabled") {
    return "This account has been disabled. Contact your workspace admin.";
  }
  if (error === "api_unavailable" || error === "local_api_unavailable") {
    return "Could not reach the API server. Start the local API or use the deployed app to sign in.";
  }
  return "Could not sign you in. Please try again.";
}

function StatusPill({
  status,
  label,
}: {
  status: "done" | "running";
  label?: string;
}) {
  const isDone = status === "done";
  return (
    <span
      className="inline-flex items-center gap-1.5 text-[11px] font-medium"
      style={{
        borderRadius: 9999,
        padding: "4px 10px",
        background: isDone ? "rgba(47,143,91,.12)" : "#eef3fe",
        color: isDone ? "#2f8f5b" : "#3e6fe0",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: isDone ? "#2f8f5b" : "#3e6fe0",
          display: "inline-block",
          ...(isDone
            ? {}
            : {
                animation: "login-pulse 1.5s ease-in-out infinite",
              }),
        }}
      />
      {label ?? (isDone ? "Done" : "Running")}
    </span>
  );
}

function UsersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <path d="m22 7-10 5L2 7" />
    </svg>
  );
}

function FileTextIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" x2="15" y1="13" y2="13" />
      <line x1="9" x2="15" y1="17" y2="17" />
    </svg>
  );
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <path d="M21.6 12.227c0-.78-.07-1.53-.2-2.25H12v4.255h5.39a4.6 4.6 0 0 1-2 3.025v2.515h3.23c1.89-1.74 2.98-4.3 2.98-7.545z" fill="#4285F4" />
      <path d="M12 22c2.7 0 4.965-.895 6.62-2.428l-3.23-2.515c-.895.6-2.04.955-3.39.955-2.605 0-4.81-1.76-5.6-4.125H3.07v2.595A10 10 0 0 0 12 22z" fill="#34A853" />
      <path d="M6.4 13.887A6 6 0 0 1 6.085 12c0-.655.11-1.295.315-1.887V7.518H3.07A10 10 0 0 0 2 12c0 1.615.385 3.145 1.07 4.482L6.4 13.887z" fill="#FBBC05" />
      <path d="M12 5.99c1.47 0 2.785.505 3.823 1.498l2.865-2.866C16.96 2.99 14.695 2 12 2 8.115 2 4.755 4.225 3.07 7.518L6.4 10.113C7.19 7.748 9.395 5.99 12 5.99z" fill="#EA4335" />
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
