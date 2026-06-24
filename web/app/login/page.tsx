import Link from "next/link";
import { LoginEmailPanel } from "@/components/LoginEmailPanel";
import { AuthButton } from "@/components/AuthButton";
import { cn } from "@/lib/utils";
import { safeAppNext } from "@/lib/safe-next";

export const metadata = {
  title: "Sign in · Floom Workers",
};

// Same-origin proxy keeps PKCE + session cookies on the dashboard host
// (workeros.floom.dev/app), not the Railway API subdomain.
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
}[] = [
  { name: "Lead research", result: "14 qualified leads", status: "done", time: "4m ago" },
  { name: "Post-call follow-up", result: "Sent to 3 contacts", status: "done", time: "11m ago" },
  { name: "Pipeline report", result: "Gathering data", status: "running", time: "now" },
  { name: "GitHub Digest", result: "14 PRs summarized", status: "done", time: "22m ago" },
];

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string; mode?: string; install?: string; switch?: string }>;
}) {
  // Next 16: searchParams is always a Promise in server components.
  const sp = (await searchParams) ?? {};
  const install = typeof sp.install === "string" ? sp.install.toLowerCase() : "";
  const next = install && INSTALL_ROUTES[install] ? INSTALL_ROUTES[install] : safeAppNext(sp.next);
  const initialMode = sp.mode === "signup" || sp.mode === "signin" ? sp.mode : "magic";
  const switchAccount = sp.switch === "1" || sp.switch === "true";
  const signupHref = `/login?mode=signup&next=${encodeURIComponent(next)}${install ? `&install=${encodeURIComponent(install)}` : ""}`;

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

      <header className="mx-auto flex w-full max-w-[1040px] px-6 py-6">
        <Link
          href="/"
          className="login-focus inline-flex items-center gap-2 rounded-[var(--radius-button)] text-[15px] font-semibold transition-opacity hover:opacity-80"
          style={{ color: "var(--ink)" }}
        >
          <FloomMark size={22} />
          Floom{" "}
          <span style={{ color: "var(--muted-text)", fontWeight: 450, marginLeft: 2 }}>/ workeros</span>
        </Link>
      </header>

      <section
        className="mx-auto grid w-full max-w-[1040px] items-start gap-14 px-6 pb-24 pt-10 md:grid-cols-[minmax(0,1fr)_400px] md:gap-20 md:pt-20"
        aria-labelledby="login-heading"
      >
        <div className="hidden max-w-[480px] md:block">
          <p
            className="font-mono text-[11px] font-medium uppercase leading-none tracking-[0.12em]"
            style={{ color: "var(--accent)" }}
          >
            Floom Cloud
          </p>
          <h2
            className="mt-5 text-[44px] font-semibold leading-[1.02]"
            style={{ color: "var(--ink)", letterSpacing: 0 }}
          >
            Hire AI workers for your company.
          </h2>
          <p
            className="mt-5 max-w-[390px] text-[15px] leading-7"
            style={{ color: "var(--muted-text)" }}
          >
            {install
              ? `Sign in to install ${install} and put it to work.`
              : "Jobs that run on a schedule, from a message, or on demand. You get the output, not the mechanics."}
          </p>

          <div
            className="mt-10 overflow-hidden"
            style={{
              background: "var(--bg-card)",
              borderRadius: "var(--radius-card)",
              border: "1px solid var(--border-default)",
            }}
          >
            <div
              className="flex items-center justify-between"
              style={{
                padding: "14px 18px 13px",
                borderBottom: "var(--bd-div)",
              }}
            >
              <span
                className="font-mono text-[11px] font-medium uppercase tracking-[0.08em]"
                style={{ color: "var(--muted-text)" }}
              >
                Recent worker runs
              </span>
              <CPill tone="ok" label="6 active" />
            </div>

            {ACTIVITY_ROWS.map((row, i) => (
              <div
                key={row.name}
                className="flex items-center gap-3.5"
                style={{
                  minHeight: 64,
                  padding: "0 18px",
                  borderTop: i > 0 ? "var(--bd-div)" : undefined,
                }}
              >
                <WorkerAvatar name={row.name} seed={row.name} size="size-10" />

                <div className="min-w-0 flex-1 py-3">
                  <div
                    className="truncate text-[14.5px] font-semibold"
                    style={{ color: "var(--ink)" }}
                  >
                    {row.name}
                  </div>
                  <div
                    className="mt-0.5 truncate text-[12.5px]"
                    style={{ color: "var(--muted-text)" }}
                  >
                    {row.result}
                  </div>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <CPill tone={row.status === "done" ? "ok" : "run"} />
                  <span
                    className="text-[11px] tabular-nums"
                    style={{ color: "var(--ink-faint)" }}
                  >
                    {row.time}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="w-full md:max-w-[380px] md:justify-self-end">
          <div
            className="rounded-[var(--radius-card)] p-7 sm:p-8 md:p-9"
            style={{
              background: "var(--bg-card)",
            }}
          >
            <div className="mb-8 space-y-2">
              <h1 id="login-heading" className="text-[28px] font-semibold leading-tight">
                Welcome back
              </h1>
              <p className="text-[14px] leading-6" style={{ color: "var(--muted-text)" }}>
                {install ? `Install ${install} after signing in.` : "Use OAuth or a magic link to enter your workspace."}
              </p>
            </div>

            <div className="space-y-2">
              <AuthButton method="google" href={oauthLoginUrl("google", next, switchAccount)} className="auth-btn auth-btn-primary">
                <GoogleIcon />
                <span>Continue with Google</span>
              </AuthButton>
              <AuthButton method="github" href={oauthLoginUrl("github", next, switchAccount)} className="auth-btn auth-btn-secondary">
                <GitHubIcon />
                <span>Continue with GitHub</span>
              </AuthButton>
            </div>

            <div className="my-5 flex items-center gap-3">
              <span className="h-px flex-1" style={{ background: "var(--line)" }} />
              <span className="font-mono text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: "var(--ink-mute)" }}>
                or
              </span>
              <span className="h-px flex-1" style={{ background: "var(--line)" }} />
            </div>

            <LoginEmailPanel next={next} initialMode={initialMode} />

            <p className="mt-6 text-center text-[11.5px] leading-[1.6]" style={{ color: "var(--ink-mute)" }}>
              By signing in you agree to the{" "}
              <Link href="/terms" className="login-focus rounded-[4px] underline underline-offset-2 transition-colors hover:text-[var(--ink)]">
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="login-focus rounded-[4px] underline underline-offset-2 transition-colors hover:text-[var(--ink)]">
                Privacy Policy
              </Link>
              . We&apos;ll create your workspace automatically on first sign-in.
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
        .auth-btn-primary {
          background: var(--ink);
          color: var(--bg-card);
        }
        .auth-btn-primary:hover { background: var(--solid-2); }
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

function CPill({ tone, label }: { tone: "ok" | "run"; label?: string }) {
  return (
    <span className={`c-pill ${tone}`} style={{ fontSize: 11, padding: "3px 9px" }}>
      <span
        className="dot"
        style={tone === "run" ? { animation: "login-pulse 1.5s ease-in-out infinite" } : undefined}
      />
      {label ?? (tone === "ok" ? "Done" : "Running")}
    </span>
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

// Inlined cloud-overlay avatar primitive. The engine's redesign branch dropped
// the shared @/components/WorkerAvatar (moved to DiceBear-based marks), but this
// pre-auth activity-proof panel wants the original muted-squircle + initials
// treatment. Local copy of the old engine WorkerAvatar (single mono register,
// rounded-[--radius-button] bg-muted) so the overlay has no dependency on the
// removed engine component.
function workerInitials(name: string): string {
  const cleaned = name.replace(/[_-]+/g, " ").trim();
  const parts = cleaned.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]?.[0] ?? "";
  const second = parts.length > 1 ? parts[parts.length - 1][0] : (parts[0]?.[1] ?? "");
  return (first + second).toUpperCase();
}

function WorkerAvatar({
  seed,
  name,
  className,
  size = "size-9",
}: {
  seed?: string;
  name?: string;
  className?: string;
  size?: string;
}) {
  const display = name || seed || "?";
  return (
    <div
      className={cn(
        "shrink-0 rounded-[var(--radius-button)] grid place-items-center font-medium tracking-tight bg-muted text-foreground",
        size,
        className,
      )}
      aria-label={`${display} avatar`}
    >
      <span className="text-[11px] leading-none">{workerInitials(display)}</span>
    </div>
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
