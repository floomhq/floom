import Link from "next/link";
import Image from "next/image";
import { SlackClaimPanel } from "./SlackClaimPanel";
import { V3Shell } from "@/app/v3/V3Shell";
import { readSession } from "@/lib/session";

export const metadata = {
  title: "Slack installed · Floom",
};

export default async function SlackInstalledPage({
  searchParams,
}: {
  searchParams?: Promise<{ team_id?: string; claim?: string; slack_error?: string }>;
}) {
  const sp = (await searchParams) ?? {};
  const teamId = sp.team_id ?? "";
  const claim = sp.claim ?? "";
  const error = sp.slack_error ?? "";
  const session = await readSession();
  const next = `/slack/installed?team_id=${encodeURIComponent(teamId)}&claim=${encodeURIComponent(claim)}`;

  return (
    <V3Shell active="product">
      <main className="mx-auto grid w-full max-w-[900px] items-center gap-10 pb-20 pt-16 md:grid-cols-[1fr_380px] md:pt-24">
        <section className="max-w-[480px]">
          <Image src="/floom-mark.svg" alt="" width={34} height={34} />
          <h1 className="mt-6 text-[36px] font-semibold leading-[1.04] tracking-[-0.032em] sm:text-[46px]">
            Emily is in your Slack.
          </h1>
          <p className="mt-4 text-[15px] leading-relaxed text-muted-foreground">
            Your workspace is ready. Claim it to manage workers on the web.
          </p>
          {teamId ? (
            <p className="mt-5 text-[12px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Slack team {teamId}
            </p>
          ) : null}
        </section>

        <section className="rounded-[18px] bg-card p-6">
          {error ? (
            <div className="space-y-4">
              <h2 className="text-[21px] font-semibold tracking-[-0.02em]">Install failed</h2>
              <p className="text-[14px] leading-relaxed text-muted-foreground">{error}</p>
              <a
                href={`${process.env.NEXT_PUBLIC_WORKEROS_API_BASE ?? "https://workeros-api.floom.dev"}/slack/install/start`}
                className="inline-flex h-11 items-center justify-center rounded-[10px] bg-foreground px-5 text-[14px] font-medium text-background"
              >
                Try again
              </a>
            </div>
          ) : !claim ? (
            <div className="space-y-4">
              <h2 className="text-[21px] font-semibold tracking-[-0.02em]">Workspace ready</h2>
              <p className="text-[14px] leading-relaxed text-muted-foreground">
                Emily can answer in Slack. A claim link can be regenerated from Slack.
              </p>
            </div>
          ) : session?.accessToken ? (
            <div className="space-y-5">
              <div>
                <h2 className="text-[21px] font-semibold tracking-[-0.02em]">Claim workspace</h2>
                <p className="mt-1 text-[13px] text-muted-foreground">{session.email ?? "Signed in"}</p>
              </div>
              <SlackClaimPanel claimToken={claim} />
            </div>
          ) : (
            <div className="space-y-5">
              <div>
                <h2 className="text-[21px] font-semibold tracking-[-0.02em]">Claim workspace</h2>
                <p className="mt-1 text-[13px] text-muted-foreground">Sign in to attach this Slack workspace.</p>
              </div>
              <Link
                href={`/login?next=${encodeURIComponent(next)}`}
                className="inline-flex h-11 items-center justify-center rounded-[10px] bg-foreground px-5 text-[14px] font-medium text-background"
              >
                Sign in to claim
              </Link>
            </div>
          )}
        </section>
      </main>
    </V3Shell>
  );
}
