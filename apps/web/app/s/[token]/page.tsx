import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchStandaloneShare } from "@/lib/server-api";
import { StandaloneShareCard } from "./StandaloneShareCard";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ token: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  try {
    const share = await fetchStandaloneShare(token);
    return {
      title: `${share.title} | Workeros share`,
      description: share.description || "Standalone Workeros share page",
      robots: {
        index: false,
        follow: false,
      },
    };
  } catch {
    return {
      title: "Workeros share",
      robots: {
        index: false,
        follow: false,
      },
    };
  }
}

export default async function StandaloneSharePage({ params }: Props) {
  const { token } = await params;
  let share;
  try {
    share = await fetchStandaloneShare(token);
  } catch {
    notFound();
  }

  return (
    <>
      <header className="flex h-14 items-center justify-between border-b border-[var(--border-soft)] px-5">
        <Link href="/" className="inline-flex items-center gap-2 text-[15px] font-semibold text-[var(--ink)]">
          <span className="grid size-[22px] place-items-center rounded-[5px] bg-[var(--primary)] text-xs font-bold text-[var(--primary-text)]">
            W
          </span>
          Workeros
        </Link>
        <Link
          href="/login"
          className="inline-flex h-8 items-center rounded-[7px] px-3 text-xs font-medium text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-[var(--ink)]"
        >
          Sign in
        </Link>
      </header>
      <StandaloneShareCard share={share} token={token} />
    </>
  );
}
