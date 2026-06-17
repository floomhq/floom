import Link from "next/link";
import { OAUTH_LOGIN_URL, OAUTH_LOGIN_URL_GITHUB } from "@/lib/api";
import { LoginEmailPanel } from "@/components/LoginEmailPanel";
import { Hl, V3Shell } from "@/app/v3/V3Shell";

export const metadata = {
  title: "Sign in · Floom Workers",
};

// Illustrative activity data shown pre-auth to demonstrate worker runs.
// No real user data — purely a proof-of-concept showcase.
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
  searchParams?: Promise<{ next?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const next = sp.next ?? "/app";

  return (
    <V3Shell active="login">
      {/* Keyframes for the Running pill dot pulse — scoped to login page */}
      <style>{`
        @keyframes login-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.3; }
        }
      `}</style>
      <main className="mx-auto grid w-full max-w-[900px] items-center gap-12 pb-20 pt-12 md:grid-cols-[1fr_360px] md:pt-20">
        {/* LEFT — Option B: activity-stream proof panel */}
        <section className="hidden max-w-[460px] md:block">
          {/* Headline */}
          <h1
            className="text-[40px] font-semibold leading-[1.04] tracking-[-0.034em]"
            style={{ color: "var(--text-primary)" }}
          >
            <Hl>Hire</Hl> AI workers.
          </h1>
          <p
            className="mt-4 max-w-[380px] text-[14px] leading-relaxed"
            style={{ color: "var(--text-muted)" }}
          >
            Describe the job, review the draft, and keep every worker run on the record.
          </p>

          {/* Activity card — white, flat, no border/shadow per design spec */}
          <div
            className="mt-7"
            style={{
              background: "var(--bg-card)",
              borderRadius: 18,
              padding: 8,
            }}
          >
            {/* Card header */}
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

            {/* Activity rows */}
            {ACTIVITY_ROWS.map((row, i) => (
              <div
                key={row.name}
                className="flex min-h-[52px] items-center gap-3"
                style={{
                  padding: 12,
                  borderTop: i > 0 ? "1px solid rgba(16,17,20,.055)" : undefined,
                }}
              >
                {/* Real-app run-row icon: 20px accent-soft squircle, accent glyph (no monogram avatar) */}
                <WorkerRowIcon />

                {/* Name + result — matches dashboard run row (name + sub-line) */}
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

                {/* Status pill + timestamp */}
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

          {/* Stat footer */}
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
        </section>

        {/* RIGHT — auth card (unchanged) */}
        <section className="rounded-[18px] bg-card p-6">
          <div className="mb-6 text-center">
            <h2 className="text-[21px] font-semibold tracking-[-0.02em]">Welcome back</h2>
            <p className="mt-1 text-[12.5px] text-muted-foreground">Magic link, password, or OAuth.</p>
          </div>

          <div className="space-y-2.5">
            <a href={OAUTH_LOGIN_URL(next)} className="flex h-11 items-center justify-center gap-2 rounded-[12px] bg-foreground px-4 text-[14px] font-medium text-background">
              <GoogleIcon />
              <span>Continue with Google</span>
            </a>
            <a href={OAUTH_LOGIN_URL_GITHUB(next)} className="flex h-11 items-center justify-center gap-2 rounded-[12px] bg-secondary px-4 text-[14px] font-medium text-foreground transition-colors hover:bg-[var(--bg-3)]">
              <GitHubIcon />
              <span>Continue with GitHub</span>
            </a>
          </div>

          <div className="my-5 text-center">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">or</span>
          </div>

          <LoginEmailPanel next={next} />

          <p className="mt-6 text-center text-[11.5px] leading-[1.6] text-muted-foreground">
            By signing in you agree to the{" "}
            <Link href="/terms" className="underline-offset-4 hover:text-foreground hover:underline">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="underline-offset-4 hover:text-foreground hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
        </section>
      </main>
    </V3Shell>
  );
}

// Run-row icon: mirrors the dashboard WorkerRowIcon — 20px accent-soft squircle
// with a small accent-colored glyph. No monogram avatar (real app has none).
function WorkerRowIcon() {
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center"
      style={{
        width: 20,
        height: 20,
        borderRadius: "var(--radius-squircle)",
        background: "var(--accent-soft)",
        color: "var(--accent)",
        border: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)",
      }}
      aria-hidden="true"
    >
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 12h4l3 8 4-16 3 8h4" />
      </svg>
    </span>
  );
}

// Status pill: Done (green tint) or Running (blue tint + pulse dot)
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
