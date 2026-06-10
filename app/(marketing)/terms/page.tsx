import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Terms — Workeros",
  description:
    "The rules that govern how you use Workeros and what you can expect from us.",
};

export default function TermsPage() {
  return (
    <main className="px-6 py-14 sm:py-20">
      <article className="mx-auto max-w-2xl">
        <p className="text-[11.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Terms of service
        </p>
        <h1 className="mt-2 text-[34px] font-semibold leading-tight tracking-[-0.025em] text-foreground sm:text-[42px]">
          The rules of the road.
        </h1>
        <p className="mt-3 text-[15px] text-muted-foreground">
          Last updated 2026-06-06. By using Workeros you agree to the terms
          below. Reach out at{" "}
          <a
            href="mailto:hello@floom.dev"
            className="font-medium text-foreground underline-offset-4 hover:text-[#3a6ea5] hover:underline"
          >
            hello@floom.dev
          </a>{" "}
          with questions.
        </p>

        <section className="mt-10 space-y-2.5">
          <h2 className="text-[20px] font-semibold text-foreground">
            What Workeros is
          </h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            Workeros lets you describe a job and runs an AI worker that does
            it on a schedule, a webhook, or with your approval. You stay in
            control of every run and every connected tool.
          </p>
        </section>

        <section className="mt-8 space-y-2.5">
          <h2 className="text-[20px] font-semibold text-foreground">
            Your account
          </h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            You are responsible for keeping your sign-in credentials safe
            and for the workers you create in your workspace. You can hire,
            edit, and retire any worker at any time.
          </p>
        </section>

        <section className="mt-8 space-y-2.5">
          <h2 className="text-[20px] font-semibold text-foreground">
            Acceptable use
          </h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            Workeros is for legitimate work. No spam, no harassment, no
            fraud, no abuse of the tools you connect, no attempts to
            reverse-engineer or disrupt the service.
          </p>
        </section>

        <section className="mt-8 space-y-2.5">
          <h2 className="text-[20px] font-semibold text-foreground">
            Worker outputs
          </h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            You own the worker outputs your workspace produces. You are
            responsible for reviewing them before they leave the platform,
            which is why workers ask for approval on anything that ships
            externally.
          </p>
        </section>

        <section className="mt-8 space-y-2.5">
          <h2 className="text-[20px] font-semibold text-foreground">
            Service availability
          </h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            We work hard to keep Workeros up and running. The service is
            provided as-is; we do not guarantee uninterrupted availability
            and we are not liable for losses that result from downtime,
            third-party tool outages, or worker behavior beyond a refund of
            fees paid for the affected period.
          </p>
        </section>

        <section className="mt-8 space-y-2.5">
          <h2 className="text-[20px] font-semibold text-foreground">
            Changes
          </h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            We may update these terms as the product grows. Material
            changes are flagged in-product and by email.
          </p>
        </section>

        <div className="mt-10 flex items-center gap-3 text-[13px]">
          <Link
            href="/"
            className="font-medium text-muted-foreground hover:text-foreground"
          >
            Back to home
          </Link>
          <span aria-hidden className="text-muted-foreground/40">
            ·
          </span>
          <Link
            href="/privacy"
            className="font-medium text-muted-foreground hover:text-foreground"
          >
            Privacy
          </Link>
        </div>
      </article>
    </main>
  );
}
