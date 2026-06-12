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
    <main className="min-h-screen flex flex-col bg-[var(--bg)] text-[var(--ink)] font-sans antialiased">
      <header className="px-6 py-5">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-[15px] font-[660] tracking-[-0.025em] text-[var(--ink)] hover:opacity-80 transition-opacity"
        >
          <FloomMark />
          Floom{" "}
          <span style={{ color: "var(--ink-mute)", fontWeight: 450, marginLeft: 2 }}>/ workeros</span>
        </Link>
      </header>

      <section className="flex-1 grid place-items-center px-6 pb-24">
        <div className="w-full max-w-[400px]">
          <div className="rounded-[var(--radius-card)] border border-[var(--line)] bg-[var(--paper)] shadow-[var(--shadow-pop)] p-8">
            <div className="text-center space-y-1.5 mb-7">
              <h1 className="text-[22px] font-semibold tracking-tight leading-tight">Sign in to Floom</h1>
              <p className="text-[13px] text-[var(--ink-soft)] leading-relaxed">AI workers that actually run</p>
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

            <p className="mt-6 text-[11.5px] leading-[1.6] text-[var(--ink-mute)] text-center">
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
          background: var(--paper);
          color: var(--ink);
          border: 1px solid var(--line);
        }
        .auth-btn-secondary:hover {
          border-color: rgba(20,20,20,0.18);
          background: var(--paper-2);
        }
      `}</style>
    </main>
  );
}

// Same play-arrow mark + lockup the landing nav uses (.ln-mark / "Floom /
// workeros"). /login only imports globals.css, not landing.css, so the mark
// is inlined here from the same SVG path rather than reusing the class.
function FloomMark({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      style={{ color: "var(--ink)" }}
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
