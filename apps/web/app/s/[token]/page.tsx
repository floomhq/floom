import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { fetchStandaloneShare } from "@/lib/server-api";
import { isAuthenticated } from "@/lib/server-auth";
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
      title: `${share.title} | Floom share`,
      description: share.description || "Standalone Floom share page",
      robots: {
        index: false,
        follow: false,
      },
    };
  } catch {
    return {
      title: "Floom share",
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

  // Worker shares are a legacy surface now; the canonical URL is the
  // /@handle/slug permalink (Fede 2026-07-06: "one URL per worker forever").
  // Old /s/<token> links keep working: permanently redirect to the canonical
  // shape instead of rendering here. redirect() is called with an ABSOLUTE
  // apex URL (not a relative path) so it escapes the dashboard's /app
  // basePath cleanly: a relative redirect() from inside a basePath-scoped
  // Next.js app would stay parked under /app/, which is the exact "ugly
  // /app/ in the address bar" bug this migration is fixing.
  if (share.entity_type === "worker" && share.permalink_redirect_url) {
    redirect(share.permalink_redirect_url);
  }

  // v6: the share card is self-contained (it carries its own Floom nav +
  // sticky CTA), so the page no longer renders a separate header.
  // FL4: pass auth state so a signed-in visitor sees "Dashboard" instead of a
  // login-bound "Add to workspace".
  const authed = await isAuthenticated();
  return <StandaloneShareCard share={share} token={token} authed={authed} />;
}
