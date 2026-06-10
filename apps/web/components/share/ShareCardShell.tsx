// Shared v6 share-card primitives. Every standalone share surface (worker,
// brain file/pack, approval) uses ONE card with the SAME fixed body height and
// the same WorkerOS nav — Federico's HARD rule. No emoji; the brand mark is a
// real SVG, never a text-in-circle.
import Link from "next/link";
import type { ReactNode } from "react";

/** Fixed share-card body height. All share surfaces match this (spec: 480px). */
export const SHARE_CARD_BODY_HEIGHT = 480;

/** WorkerOS wordmark + SVG mark (matches the v6 spec #workeros-mark symbol). */
export function WorkerosMark({ size = 22, label = "WorkerOS" }: { size?: number; label?: string }) {
  return (
    <Link href="/" className="inline-flex items-center gap-2 text-[15px] font-semibold text-[var(--ink)] no-underline">
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        xmlns="http://www.w3.org/2000/svg"
        role="img"
        aria-label="WorkerOS"
        style={{ borderRadius: "22%", color: "var(--ink)" }}
      >
        <rect width="100" height="100" rx="22" fill="currentColor" />
        <path
          d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
          fill="#FFFFFF"
        />
      </svg>
      {label}
    </Link>
  );
}

/** Standalone top nav for a share page: WorkerOS mark on the left, a slot on the right. */
export function ShareNav({ right }: { right?: ReactNode }) {
  return (
    <div className="flex items-center justify-between rounded-t-[var(--radius-card)] border-b border-[var(--border-soft)] bg-[var(--bg-card)] px-5 py-3">
      <WorkerosMark />
      {right}
    </div>
  );
}

/**
 * The outer shell that holds ONE share card. It carries the nav, an optional
 * pre-card region (breadcrumb / hint line), and a fixed-height body. Children
 * are the card body content; consumers manage internal scroll WITHIN the body
 * (the page itself never grows past the card).
 */
export function ShareCardShell({
  navRight,
  children,
  maxWidth = 680,
}: {
  navRight?: ReactNode;
  children: ReactNode;
  maxWidth?: number;
}) {
  return (
    <div className="mx-auto w-full px-3 py-10" style={{ maxWidth }}>
      <div className="rounded-[var(--radius-card)] border border-[var(--card-border)] bg-[var(--bg-app)] shadow-[var(--shadow-pop)]">
        <ShareNav right={navRight} />
        {children}
      </div>
    </div>
  );
}

/**
 * Fixed-height card body. Flex column with hidden overflow — internal panes
 * scroll within themselves; the body never grows. This is the single source of
 * truth for the "all share cards same fixed height" rule.
 */
export function ShareCardBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex flex-col overflow-hidden ${className ?? ""}`}
      style={{ height: SHARE_CARD_BODY_HEIGHT }}
    >
      {children}
    </div>
  );
}
