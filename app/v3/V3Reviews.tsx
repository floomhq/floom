"use client";

/**
 * V3Reviews — real ratings + reviews for a worker/workspace. Reads/writes via
 * the landing route handlers (which proxy to the FastAPI backend). Degrades
 * gracefully: shows an honest empty state until real reviews exist. No fake
 * stars, no emoji (SVG stars), borderless, cool palette.
 */

import { useCallback, useEffect, useState } from "react";

type Review = { id: string; rating: number; body: string; created_at: string };

function Star({ on, className = "h-3.5 w-3.5" }: { on: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 20 20" className={`shrink-0 ${className}`} aria-hidden="true">
      <path
        d="M10 1.6l2.47 5.18 5.7.62-4.25 3.84 1.16 5.6L10 14.9l-5.08 2.74 1.16-5.6L1.83 8.2l5.7-.62z"
        fill={on ? "var(--v3-accent)" : "none"}
        stroke="var(--v3-accent)"
        strokeWidth={on ? 0 : 1.4}
        opacity={on ? 1 : 0.35}
      />
    </svg>
  );
}

function Stars({ value, className = "h-3.5 w-3.5" }: { value: number; className?: string }) {
  return (
    <span className="inline-flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} on={n <= Math.round(value)} className={className} />
      ))}
    </span>
  );
}

export function V3Reviews({
  itemKind,
  itemSlug,
  source = "first_party",
}: {
  itemKind: "worker" | "workspace";
  itemSlug: string;
  source?: "first_party" | "community";
}) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [rating, setRating] = useState(0);
  const [body, setBody] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "done" | "auth" | "error">("idle");

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/marketplace/reviews?item_kind=${itemKind}&item_slug=${itemSlug}&source=${source}`,
        { cache: "no-store" },
      );
      const data = await res.json();
      setReviews(Array.isArray(data.reviews) ? data.reviews : []);
    } catch {
      setReviews([]);
    } finally {
      setLoaded(true);
    }
  }, [itemKind, itemSlug, source]);

  useEffect(() => {
    load();
  }, [load]);

  const avg = reviews.length
    ? reviews.reduce((s, r) => s + r.rating, 0) / reviews.length
    : 0;

  async function submit() {
    if (!rating || body.trim().length < 1) return;
    setState("saving");
    try {
      const res = await fetch("/api/marketplace/reviews", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ item_kind: itemKind, item_slug: itemSlug, source, rating, body }),
      });
      if (res.status === 401 || res.status === 403) return setState("auth");
      if (!res.ok) return setState("error");
      setState("done");
      setBody("");
      setRating(0);
      load();
    } catch {
      setState("error");
    }
  }

  return (
    <div className="pb-20">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[22px] font-semibold tracking-[-0.018em]">Reviews</h2>
        {reviews.length > 0 && (
          <span className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Stars value={avg} />
            {avg.toFixed(1)} · {reviews.length} {reviews.length === 1 ? "review" : "reviews"}
          </span>
        )}
      </div>

      {loaded && reviews.length === 0 && (
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          No reviews yet — be the first to review this {itemKind}.
        </p>
      )}

      {reviews.length > 0 && (
        <div className="mt-5 space-y-4">
          {reviews.map((r) => (
            <div key={r.id} className="rounded-[12px] bg-secondary/50 p-4">
              <Stars value={r.rating} />
              <p className="mt-2 text-[13.5px] leading-relaxed text-foreground/80">{r.body}</p>
            </div>
          ))}
        </div>
      )}

      {/* write a review */}
      <div className="mt-6 rounded-[14px] bg-secondary/40 p-4">
        <div className="flex items-center gap-2">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" onClick={() => setRating(n)} aria-label={`${n} stars`}>
              <Star on={n <= rating} className="h-5 w-5" />
            </button>
          ))}
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="What did this worker do for you?"
          rows={3}
          className="mt-3 w-full resize-none rounded-[10px] bg-card px-3 py-2.5 text-[13.5px] placeholder:text-muted-foreground focus:outline-none"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            type="button"
            onClick={submit}
            disabled={!rating || body.trim().length < 1 || state === "saving"}
            className="inline-flex h-9 items-center rounded-[10px] px-4 text-[13px] font-medium text-white disabled:opacity-40"
            style={{ background: "var(--v3-accent)" }}
          >
            {state === "saving" ? "Posting…" : "Post review"}
          </button>
          {state === "done" && <span className="text-[12.5px] text-muted-foreground">Thanks — posted.</span>}
          {state === "auth" && (
            <a href={`/login?next=/templates/${itemSlug}`} className="text-[12.5px] underline" style={{ color: "var(--v3-accent)" }}>
              Sign in to review
            </a>
          )}
          {state === "error" && <span className="text-[12.5px] text-muted-foreground">Couldn&apos;t post — try again.</span>}
        </div>
      </div>
    </div>
  );
}
