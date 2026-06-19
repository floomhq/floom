import type { Metadata } from "next";
import { ReviewFlow } from "./ReviewFlow";

// Public, token-gated client review flow. Rendered dynamically (no static
// pre-render of a share surface) and never indexed — the token in the URL is a
// secret. The actual pack is fetched client-side AFTER the pack password unlock,
// so nothing sensitive is server-rendered into the HTML.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Kandidaten-Review",
  robots: { index: false, follow: false },
};

type Props = {
  params: Promise<{ token: string }>;
};

export default async function ReviewPackPage({ params }: Props) {
  const { token } = await params;
  return <ReviewFlow token={token} />;
}
