import Link from "next/link";
import { OAUTH_LOGIN_URL, OAUTH_LOGIN_URL_GITHUB } from "@/lib/api";
import { LoginEmailPanel } from "@/components/LoginEmailPanel";

export const metadata = {
  title: "Sign in · Floom",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string }>;
}) {
  // Next 16: searchParams is always a Promise in server components.
  const sp = (await searchParams) ?? {};
  const next = sp.next ?? "/";

  return (
    <main className="login-cool min-h-screen bg-[var(--bg-app)] text-[var(--ink)] font-sans antialiased">
      <header className="mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-[15px] font-[660] tracking-[-0.025em] text-[var(--ink)] hover:opacity-80 transition-opacity"
        >
          <FloomMark />
          WorkerOS
          <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-[var(--ink-mute)]">by Floom</span>
        </Link>
        <Link href="/" className="hidden rounded-[10px] px-3 py-1.5 text-[13px] text-[var(--ink-soft)] transition hover:bg-[var(--bg-2)] hover:text-[var(--ink)] sm:block">
          Back to landing
        </Link>
      </header>

      <section className="mx-auto grid min-h-[calc(100vh-64px)] w-full max-w-6xl items-center gap-10 px-6 pb-20 pt-8 md:grid-cols-[1fr_420px]">
        <div className="hidden max-w-[520px] md:block">
          <div className="inline-flex rounded-full bg-[var(--sel)] px-3 py-1 text-[12px] font-medium text-[var(--accent)]">
            Cloud sign-in
          </div>
          <h1 className="mt-5 text-[46px] font-semibold leading-[1.02] tracking-[-0.036em] text-[var(--ink)]">
            Your workers, approvals, and runs in one calm place.
          </h1>
          <p className="mt-4 max-w-[420px] text-[15px] leading-relaxed text-[var(--ink-soft)]">
            Sign in to review drafts, connect tools, and keep every worker on the record.
          </p>
          <div className="mt-8 rounded-[18px] bg-[var(--bg-card)] p-4 ring-1 ring-[var(--line)]">
            <div className="flex items-center justify-between border-b border-[var(--line-soft)] pb-3">
              <span className="text-[13px] font-medium">Client Follow-up Worker</span>
              <span className="rounded-full bg-[var(--sel)] px-2.5 py-1 text-[10.5px] font-medium text-[var(--accent)]">Needs approval</span>
            </div>
            <div className="space-y-3 pt-3">
              {["Read calendar notes", "Drafted Sarah follow-up", "Holding send for approval"].map((item, index) => (
                <div key={item} className="flex items-center gap-3 text-[12.5px] text-[var(--ink-soft)]">
                  <span className={`h-1.5 w-1.5 rounded-full ${index === 2 ? "bg-[var(--accent)]" : "bg-[var(--ink-mute)]"}`} />
                  {item}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="w-full max-w-[420px] justify-self-center">
          <div className="rounded-[18px] border border-[var(--line)] bg-[var(--bg-card)] p-7 shadow-[0_18px_56px_rgba(16,17,20,0.08)]">
            <div className="mb-7 space-y-1.5 text-center">
              <div className="mx-auto mb-4 flex h-10 w-10 items-center justify-center rounded-[12px] bg-[var(--ink)] text-[var(--bg-card)]">
                <FloomMark size={20} inverted />
              </div>
              <h1 className="text-[23px] font-semibold leading-tight tracking-[-0.024em]">Sign in to WorkerOS</h1>
              <p className="text-[13px] leading-relaxed text-[var(--ink-soft)]">Magic link or password. Same workspace, same worker record.</p>
            </div>
            <div className="space-y-2.5">
              <a href={OAUTH_LOGIN_URL(next)} className="auth-btn auth-btn-primary">
                <GoogleIcon />
                <span>Continue with Google</span>
              </a>
              <a href={OAUTH_LOGIN_URL_GITHUB(next)} className="auth-btn auth-btn-secondary">
                <GitHubIcon />
                <span>Continue with GitHub</span>
              </a>
            </div>

            <div className="my-5 flex items-center gap-3">
              <span className="h-px flex-1 bg-[var(--line)]" />
              <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-[var(--ink-mute)]">or</span>
              <span className="h-px flex-1 bg-[var(--line)]" />
            </div>

            <LoginEmailPanel next={next} />

            <p className="mt-6 text-center text-[11.5px] leading-[1.6] text-[var(--ink-mute)]">
              By signing in you agree to the{" "}
              <Link href="/terms" className="underline underline-offset-2 hover:text-[var(--ink)] transition-colors">
                Terms
              </Link>{" "}
              and{" "}
              <Link href="/privacy" className="underline underline-offset-2 hover:text-[var(--ink)] transition-colors">
                Privacy Policy
              </Link>
              . We&apos;ll create your workspace automatically on first sign-in.
            </p>
          </div>

          <p className="mt-5 text-center text-[12px] text-[var(--ink-mute)]">
            New here?{" "}
            <Link href="/" className="text-[var(--ink-soft)] hover:text-[var(--ink)] underline underline-offset-2 transition-colors">
              See what Floom does
            </Link>
          </p>
        </div>
      </section>

      <style>{`
        .login-cool {
          --bg-app: #FBFBFC;
          --bg-card: #FFFFFF;
          --bg-2: #F3F4F6;
          --bg-3: #ECEDF0;
          --ink: #16171A;
          --ink-soft: #6B7280;
          --ink-mute: rgba(107, 114, 128, 0.78);
          --line: rgba(16, 17, 20, 0.09);
          --line-soft: rgba(16, 17, 20, 0.055);
          --accent: #3E6FE0;
          --sel: #EEF3FE;
          --solid: #16171A;
          --solid-2: #2A2C31;
          --solid-fg: #FFFFFF;
          --success: #2F8F5B;
          --warning: #E5533D;
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
          letter-spacing: -0.005em;
          text-decoration: none;
          transition: transform 120ms cubic-bezier(0.2, 0.7, 0.2, 1), background 120ms, border-color 120ms;
        }
        .auth-btn:active { transform: translateY(1px); }
        .auth-btn-primary {
          background: var(--solid);
          color: var(--solid-fg);
          border: 1px solid var(--solid);
          box-shadow: 0 1px 0 rgba(0,0,0,0.04), inset 0 1px 0 rgba(255,255,255,0.06);
        }
        .auth-btn-primary:hover { background: var(--solid-2); }
        .auth-btn-secondary {
          background: var(--bg-card);
          color: var(--ink);
          border: 1px solid var(--line);
        }
        .auth-btn-secondary:hover {
          border-color: rgba(20,20,20,0.18);
          background: var(--bg-2);
        }
        .auth-btn-accent {
          background: var(--accent);
          color: #fff;
          border: 1px solid var(--accent);
        }
        .auth-btn-accent:hover {
          background: #315EC6;
        }
      `}</style>
    </main>
  );
}

// Same play-arrow mark + lockup the landing nav uses (.ln-mark / "Floom /
// workeros"). /login only imports globals.css, not landing.css, so the mark
// is inlined here from the same SVG path rather than reusing the class.
function FloomMark({ size = 20, inverted = false }: { size?: number; inverted?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      style={{ color: inverted ? "var(--bg-card)" : "var(--ink)" }}
    >
      <path
        d="M32 26h20l22 22a3 3 0 0 1 0 4l-22 22H32a6 6 0 0 1-6-6V32a6 6 0 0 1 6-6z"
        fill="currentColor"
      />
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
