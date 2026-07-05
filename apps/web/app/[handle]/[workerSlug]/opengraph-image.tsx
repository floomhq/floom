import type { ReactElement } from "react";
import { ImageResponse } from "next/og";
import { fetchPublicWorkerPermalink } from "@/lib/server-api";
import type { PublicWorkerPermalink } from "@/lib/types";

// L4 permalink og-image. PUBLIC by design (Slack/Twitter/LinkedIn scrapers are
// unauthenticated) BUT gated on the worker's public flag: the fetch returns
// null for a non-public / unknown handle+slug, and we render a GENERIC Floom
// placeholder — never a private worker's specifics (no slug enumeration leak).
//
// Cached hard at the edge so scraper traffic never hammers the DB: a full day
// revalidate + immutable-style semantics. Cool Floom palette (#FBFBFC ground,
// black squircle mark), no neon.

export const runtime = "edge";
export const alt = "Floom worker";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const revalidate = 86400;

const INK = "#0B0B0C";
const INK_SOFT = "#565866";
const GROUND = "#FBFBFC";
const SURFACE = "#F3F4F6";

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function FloomMark({ size: s = 64 }: { size?: number }) {
  return (
    <svg width={s} height={s} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <rect width="100" height="100" rx="22" fill="#1a1a1a" />
      <path
        d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
        fill="#FFFFFF"
      />
    </svg>
  );
}

function scheduleLabel(triggerType: string): string {
  switch ((triggerType || "").toLowerCase()) {
    case "schedule":
    case "cron":
      return "Scheduled";
    case "webhook":
      return "Webhook";
    case "manual":
      return "On demand";
    default:
      return triggerType ? triggerType : "On demand";
  }
}

const CACHE_HEADERS = {
  "Cache-Control": "public, max-age=86400, s-maxage=86400, immutable",
};

// Generic Floom placeholder — the ONLY tree proven to always render, so it is
// the guaranteed fallback (never leaks worker specifics either).
function PlaceholderCard(): ReactElement {
  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 28,
        background: GROUND,
      }}
    >
      <FloomMark size={96} />
      <div style={{ fontSize: 44, fontWeight: 600, color: INK }}>Floom</div>
      <div style={{ fontSize: 26, color: INK_SOFT }}>Hire AI workers</div>
    </div>
  );
}

function WorkerCard({ card }: { card: PublicWorkerPermalink }): ReactElement {
  const worker = card.worker;
  const connections = (worker.connections || []).slice(0, 5);
  const schedule = scheduleLabel(worker.trigger_type);
  const sharer = card.shared_by?.label || card.workspace.name;
  const description = worker.description
    ? worker.description.length > 140
      ? `${worker.description.slice(0, 140)}…`
      : worker.description
    : "";

  return (
    <div
      style={{
        width: "100%",
        height: "100%",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        background: GROUND,
        padding: "72px 80px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <FloomMark size={56} />
        <div style={{ fontSize: 30, fontWeight: 600, color: INK }}>Floom</div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
        {/* CRITICAL (Satori/#1022): every text div below has EXACTLY ONE child.
            `<div>Shared by {sharer}</div>` is a text node PLUS an expression =
            two children, and Satori hard-throws "expected display:flex … if it
            has more than one child" MID-STREAM on a non-flex div, which the edge
            served as a 200 with a 0-byte body. Keep each interpolation a single
            concatenated string (or give the div display:flex). */}
        <div style={{ fontSize: 26, color: INK_SOFT }}>{`Shared by ${sharer}`}</div>
        <div
          style={{
            fontSize: 76,
            fontWeight: 700,
            color: INK,
            lineHeight: 1.05,
            maxWidth: 1000,
          }}
        >
          {worker.name}
        </div>
        {description ? (
          <div style={{ fontSize: 30, color: INK_SOFT, maxWidth: 960, lineHeight: 1.35 }}>
            {description}
          </div>
        ) : null}
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div
          style={{
            display: "flex",
            fontSize: 24,
            fontWeight: 500,
            color: INK,
            background: SURFACE,
            padding: "10px 22px",
            borderRadius: 999,
          }}
        >
          {schedule}
        </div>
        {connections.map((c) => (
          <div
            key={c}
            style={{
              display: "flex",
              fontSize: 24,
              color: INK_SOFT,
              background: SURFACE,
              padding: "10px 22px",
              borderRadius: 999,
            }}
          >
            {c}
          </div>
        ))}
      </div>
    </div>
  );
}

// Render an element to a fully-buffered PNG Response. `ImageResponse` streams
// lazily: a Satori throw surfaces only while the body is piped, so the edge
// serves a 200 with an EMPTY body (the worst failure mode for scrapers). We
// drain the stream to a buffer HERE so any such throw is catchable by the
// caller, which then falls back to the always-valid placeholder.
async function renderPng(element: ReactElement): Promise<Response> {
  const image = new ImageResponse(element, { ...size, headers: CACHE_HEADERS });
  const buffer = await image.arrayBuffer();
  return new Response(buffer, {
    headers: { ...CACHE_HEADERS, "Content-Type": "image/png" },
  });
}

export default async function OpengraphImage({
  params,
}: {
  params: Promise<{ handle: string; workerSlug: string }>;
}) {
  const { handle: rawHandle, workerSlug: rawSlug } = await params;
  const handle = decode(rawHandle);
  const workerSlug = decode(rawSlug);
  const card = await fetchPublicWorkerPermalink(handle, workerSlug).catch(() => null);

  // Non-public / unknown -> generic Floom placeholder (never worker specifics).
  // Construct the element OUTSIDE the try (JSX construction never throws; the
  // Satori render + throw happens inside renderPng's arrayBuffer() drain).
  if (card) {
    const workerCard = <WorkerCard card={card} />;
    try {
      return await renderPng(workerCard);
    } catch (err) {
      // Never stream an empty 200: on ANY render failure fall through to the
      // placeholder, which is the only tree guaranteed to rasterize.
      console.error("[og:permalink] worker card render failed, using placeholder", err);
    }
  }

  return await renderPng(<PlaceholderCard />);
}
