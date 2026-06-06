import type { Metadata } from "next";
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

  // v6: the share card is self-contained (it carries its own Workeros nav +
  // sticky CTA), so the page no longer renders a separate header.
  return <StandaloneShareCard share={share} token={token} />;
}
