import Link from "next/link";
import { LoginEmailPanel } from "@/components/LoginEmailPanel";
import { cn } from "@/lib/utils";
import { safeAppNext } from "@/lib/safe-next";

export const metadata = {
  title: "Sign in · Floom",
};

const API_BASE = process.env.NEXT_PUBLIC_WORKEROS_API_BASE ?? "https://workeros-api.floom.dev";

const oauthLoginUrl = (provider: "google" | "github", next = "/app") =>
  `${API_BASE}/auth/login?provider=${provider}&next=${encodeURIComponent(safeAppNext(next))}`;

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
  searchParams?: Promise<{ next?: string; mode?: string; install?: string }>;
}) {
  // Next 16: searchParams is always a Promise in server components.
  const sp = (await searchParams) ?? {};
  const install = typeof sp.install === "string" ? sp.install.toLowerCase() : "";
  const next = install && INSTALL_ROUTES[install] ? INSTALL_ROUTES[install] : safeAppNext(sp.next);
  const initialMode = sp.mode === "signup" || sp.mode === "signin" ? sp.mode : "magic";
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

      <header className="px-6 py-5">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-[15px] font-[660] tracking-[-0.025em] transition-opacity hover:opacity-80"
          style={{ color: "var(--text-primary)" }}
        >
          <FloomMark />
          Floom{" "}
          <span style={{ color: "var(--text-muted)", fontWeight: 450, marginLeft: 2 }}>/ workeros</span>
        </Link>
      </header>

      <section className="mx-auto grid w-full max-w-[900px] items-center gap-12 px-6 pb-24 pt-6 md:grid-cols-[1fr_380px] md:pt-16">
        {/* LEFT: L2 refined activity-proof panel. Built from the dashboard's
            own primitives — WorkerAvatar (rounded-[--radius-button] bg-muted
            squircle) + the .c-pill ok/run status pills + design tokens — so it
            reads as a slice of the real product, not a login mockup. Flat by
            token (--shadow-card: none); separation via bg-step + hairline. */}
        <div className="hidden max-w-[460px] md:block">
          <h1
            className="text-[40px] font-semibold leading-[1.04] tracking-[-0.034em]"
            style={{ color: "var(--text-primary)" }}
          >
            Workers that{" "}
            <span style={{ color: "var(--accent)" }}>actually run</span>.
          </h1>
          <p
            className="mt-4 max-w-[380px] text-[14px] leading-relaxed"
            style={{ color: "var(--text-muted)" }}
          >
            {install
              ? `Sign in to install ${install} and put it to work.`
              : "A glimpse of a workspace today:"}
          </p>

          {/* Activity feed, flat: bg-step + hairline only, no drop-shadow. */}
          <div
            className="mt-7 overflow-hidden"
            style={{
              background: "var(--bg-card)",
              borderRadius: "var(--radius-card)",
              boxShadow: "var(--hairline)",
            }}
          >
            {/* Feed header */}
            <div
              className="flex items-center justify-between"
              style={{
                padding: "13px 18px 12px",
                borderBottom: "var(--bd-div)",
              }}
            >
              <span
                className="text-[11px] font-medium uppercase tracking-[0.06em]"
                style={{ color: "var(--muted-foreground)" }}
              >
                Today
              </span>
              <CPill tone="ok" label="6 active" />
            </div>

            {/* Activity rows — same geometry as the dashboard's .c-lrow. */}
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

                {/* Name + outcome */}
                <div className="min-w-0 flex-1 py-3">
                  <div
                    className="truncate text-[14.5px] font-semibold tracking-[-0.01em]"
                    style={{ color: "var(--ink)" }}
                  >
                    {row.name}
                  </div>
                  <div
                    className="mt-0.5 truncate text-[12.5px]"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    {row.result}
                  </div>
                </div>

                {/* Status pill + timestamp */}
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

          {/* Stat footer */}
          <div
            className="mt-4 flex items-center gap-2 text-[13px]"
            style={{ color: "var(--muted-foreground)" }}
          >
            142 runs today
            <Dot />
            0 need attention
            <Dot />
            avg 38s
          </div>
        </div>

        {/* RIGHT: auth card. Dashboard auth wiring preserved verbatim. */}
        <div className="w-full md:max-w-[380px] md:justify-self-end">
          <div
            className="rounded-[var(--radius-card)] p-8"
            style={{
              background: "var(--bg-card)",
              boxShadow: "0 1px 2px rgba(16,17,20,.04), 0 16px 40px rgba(16,17,20,.07)",
            }}
          >
            <div className="mb-7 space-y-1.5 text-center">
              <h2 className="text-[22px] font-semibold leading-tight tracking-tight">Welcome back</h2>
              <p className="text-[13px] leading-relaxed" style={{ color: "var(--ink-soft)" }}>
                {install ? `Sign in to install ${install}` : "Magic link, password, or OAuth."}
              </p>
            </div>

            <div className="space-y-2.5">
              <a href={oauthLoginUrl("google", next)} className="auth-btn auth-btn-primary">
                <GoogleIcon />
                <span>Continue with Google</span>
              </a>
              <a href={oauthLoginUrl("github", next)} className="auth-btn auth-btn-secondary">
                <GitHubIcon />
                <span>Continue with GitHub</span>
              </a>
            </div>

            <div className="my-5 flex items-center gap-3">
              <span className="h-px flex-1" style={{ background: "var(--line)" }} />
              <span className="text-[11px] font-medium uppercase tracking-[0.08em]" style={{ color: "var(--ink-mute)" }}>
                or
              </span>
              <span className="h-px flex-1" style={{ background: "var(--line)" }} />
            </div>

            <LoginEmailPanel next={next} initialMode={initialMode} />

            <p className="mt-6 text-center text-[11.5px] leading-[1.6]" style={{ color: "var(--ink-mute)" }}>
              By signing in you agree to the{" "}
              <Link href="/terms" className="underline underline-offset-2 transition-colors hover:text-[var(--ink)]">
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="underline underline-offset-2 transition-colors hover:text-[var(--ink)]">
                Privacy Policy
              </Link>
              . We&apos;ll create your workspace automatically on first sign-in.
            </p>
          </div>

          <p className="mt-5 text-center text-[12px]" style={{ color: "var(--ink-mute)" }}>
            New here?{" "}
            <Link href={signupHref} className="underline underline-offset-2 transition-colors hover:text-[var(--ink)]" style={{ color: "var(--ink-soft)" }}>
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
          letter-spacing: -0.005em;
          text-decoration: none;
          transition: transform 120ms cubic-bezier(0.2, 0.7, 0.2, 1), background 120ms, opacity 120ms;
        }
        .auth-btn:active { transform: translateY(1px); }
        .auth-btn-primary {
          background: var(--solid);
          color: var(--solid-fg);
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

function Dot() {
  return (
    <span
      style={{
        width: 3,
        height: 3,
        borderRadius: "50%",
        background: "var(--ink-faint)",
        display: "inline-block",
      }}
    />
  );
}

// Status pill: reuses the dashboard's own .c-pill primitive (globals.css)
// with the real tones — ok = --success tint, run = --info tint — so it is the
// exact pill the collection rows use, not a re-skin. The run dot pulses to
// convey live state (the only login-scoped flourish).
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

// Same play-arrow mark + lockup the landing nav uses (.ln-mark / "Floom /
// workeros"). /app/login only imports globals.css, not landing.css, so the
// mark is inlined here from the same SVG path rather than reusing the class.
function FloomMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      style={{ color: "var(--text-primary)" }}
    >
      <path
        d="M32 26h20l22 22a3 3 0 0 1 0 4l-22 22H32a6 6 0 0 1-6-6V32a6 6 0 0 1 6-6z"
        fill="currentColor"
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
