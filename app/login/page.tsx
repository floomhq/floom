import Link from "next/link";
import Image from "next/image";
import { OAUTH_LOGIN_URL, OAUTH_LOGIN_URL_GITHUB } from "@/lib/api";
import { LoginEmailPanel } from "@/components/LoginEmailPanel";
import { V3Shell } from "@/app/v3/V3Shell";

export const metadata = {
  title: "Sign in · Floom Workers",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams?: Promise<{ next?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const next = sp.next ?? "/app";

  return (
    <V3Shell active="login">
      <main className="mx-auto grid w-full max-w-[820px] items-center gap-10 pb-20 pt-16 md:grid-cols-[1fr_360px] md:pt-24">
        <section className="max-w-[430px]">
          <Image src="/floom-mark.svg" alt="" width={34} height={34} />
          <h1 className="mt-6 text-[36px] font-semibold leading-[1.04] tracking-[-0.032em] sm:text-[46px]">
            Sign in to Floom Workers.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
            Review drafts, connect tools, and keep every worker run on the record.
          </p>
        </section>

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
