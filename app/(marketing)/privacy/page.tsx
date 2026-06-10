import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy — Workeros",
  description:
    "How Workeros handles your data, your worker runs, and the tools you connect.",
};

export default function PrivacyPage() {
  return (
    <main className="px-6 py-14 sm:py-20">
      <article className="prose-workeros mx-auto max-w-2xl">
        <p className="text-[11.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          Privacy
        </p>
        <h1 className="mt-2 text-[34px] font-semibold leading-tight tracking-[-0.025em] text-foreground sm:text-[42px]">
          How Workeros handles your data.
        </h1>
        <p className="mt-3 text-[15px] text-muted-foreground">
          Last updated 2026-06-06. This is the short version; reach out at{" "}
          <a
            href="mailto:hello@floom.dev"
            className="font-medium text-foreground underline-offset-4 hover:text-[#3a6ea5] hover:underline"
          >
            hello@floom.dev
          </a>{" "}
          for the long one.
        </p>

        <section className="mt-10 space-y-2.5">
          <h2 className="text-[20px] font-semibold text-foreground">
            What we store
          </h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            The prompts you write, the workers you create, the runs they
            produce, and the connections you authorize. We store enough to
            show every run on the record so you can audit what a worker did
            on your behalf.
          </p>
        </section>

        <section className="mt-8 space-y-2.5">
          <h2 className="text-[20px] font-semibold text-foreground">
            Your connected tools
          </h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            When you connect Gmail, Slack, HubSpot, Notion, or any of the
            1,000+ tools we support via Composio, Workeros holds the
            OAuth token and uses it only to run the workers you build.
            Revoking access in the source tool stops every worker that
            depends on it.
          </p>
        </section>

        <section className="mt-8 space-y-2.5">
          <h2 className="text-[20px] font-semibold text-foreground">
            Who can see your data
          </h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            Your workspace and its members. Workeros support reviews data
            only when you ask us to debug a run. We do not sell data, we do
            not train shared models on your worker outputs, and we do not
            share your data with third parties beyond the tools you connect.
          </p>
        </section>

        <section className="mt-8 space-y-2.5">
          <h2 className="text-[20px] font-semibold text-foreground">
            Deleting your data
          </h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            Workspace owners can delete a workspace from settings. Deletion
            removes worker definitions, run history, connection tokens, and
            uploaded company brain documents from primary storage within 7
            days and from backups within 30.
          </p>
        </section>

        <section className="mt-8 space-y-2.5">
          <h2 className="text-[20px] font-semibold text-foreground">
            Contact
          </h2>
          <p className="text-[15px] leading-relaxed text-muted-foreground">
            Questions about your data, a request to delete it, or a security
            report:{" "}
            <a
              href="mailto:hello@floom.dev"
              className="font-medium text-foreground underline-offset-4 hover:text-[#3a6ea5] hover:underline"
            >
              hello@floom.dev
            </a>
            .
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
            href="/terms"
            className="font-medium text-muted-foreground hover:text-foreground"
          >
            Terms
          </Link>
        </div>
      </article>
    </main>
  );
}
