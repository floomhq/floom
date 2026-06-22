// WorkerOS identity mark — the ONE shared avatar component.
// SPEC: /root/workeros-design-baseline/SPEC.md (locked 2026-06-22).
//
// Shape encodes ROLE:
//   - "user"      -> CIRCLE (human). Real provider photo when `src` present,
//                    else a chunky 2-tone generated mark. NEVER initials.
//   - "workspace" -> SQUIRCLE (non-human). Uploaded logo/favicon when `src`
//                    present, else the SAME generated mark.
//   - "worker"    -> SQUIRCLE (non-human). Same as workspace; workers are
//                    non-human entities (run cards, share cards).
//   - "emily"     -> SQUIRCLE, solid accent-blue, fixed A4 mark (white core
//                    disc + two white@55% energy arcs). Gentle arc PULSE when
//                    `active`, respecting prefers-reduced-motion.
//
// No gradients, no faces, no stock glyphs (radar/orbit/star), no letters.
// Tokens only: --accent (Emily blue), --radius-squircle (squircle radius).
import { generateMark, MARK_GROUND, type MarkMotif } from "@/lib/avatar/generate";

export type AvatarRole = "user" | "workspace" | "worker" | "emily";

export interface AvatarProps {
  role: AvatarRole;
  /**
   * Identity seed for the generated fallback. For user pass name/email; for
   * workspace/worker pass the display name. Ignored for Emily (fixed mark).
   */
  name?: string;
  /** Explicit seed override; falls back to `name`. */
  id?: string;
  /**
   * Real photo (user) or logo/favicon (workspace/worker) URL. When present it
   * renders cropped to the role shape instead of the generated mark.
   */
  src?: string | null;
  /** Pixel size sets explicit width/height. A string is applied as className. */
  size?: number | string;
  className?: string;
  /**
   * Accessible label. When omitted the mark is decorative (aria-hidden) — use a
   * label only when the avatar is not adjacent to a visible name.
   */
  "aria-label"?: string;
  /**
   * Emily only: animate the energy arcs (pulse) while she is actively working.
   * Reduced-motion users get the static mark. No-op for other roles.
   */
  active?: boolean;
}

function shapeStyle(role: AvatarRole): { borderRadius: string } {
  return {
    borderRadius: role === "user" ? "9999px" : "var(--radius-squircle)",
  };
}

/** The 6 chunky motifs, drawn in a 48-unit viewBox (matches the reference). */
function MotifBody({ motif, c1, c2 }: { motif: MarkMotif; c1: string; c2: string }) {
  switch (motif) {
    case "concentric":
      return (
        <>
          <circle cx="24" cy="24" r="14" fill={c2} />
          <circle cx="24" cy="24" r="8.5" fill={c1} />
        </>
      );
    case "cross":
      return (
        <>
          <rect x="8" y="19" width="32" height="10" rx="5" fill={c2} />
          <rect x="19" y="8" width="10" height="32" rx="5" fill={c1} />
        </>
      );
    case "split":
      return (
        <>
          <path d="M10 24a14 14 0 0 1 28 0z" fill={c1} />
          <path d="M10 24a14 14 0 0 0 28 0z" fill={c2} />
        </>
      );
    case "twin":
      return (
        <>
          <circle cx="16.5" cy="24" r="9" fill={c1} />
          <circle cx="31.5" cy="24" r="9" fill={c2} />
        </>
      );
    case "square-disc":
      return (
        <>
          <rect x="9" y="9" width="30" height="30" rx="8" fill={c2} />
          <circle cx="24" cy="24" r="9" fill={c1} />
        </>
      );
    case "stacked-bars":
      return (
        <>
          <rect x="11" y="13" width="26" height="9" rx="4.5" fill={c1} />
          <rect x="11" y="26" width="26" height="9" rx="4.5" fill={c2} />
        </>
      );
  }
}

/** Emily's fixed A4 mark — white core disc + two white@55% energy arcs. */
function EmilyA4({ active }: { active?: boolean }) {
  return (
    <>
      <circle cx="24" cy="24" r="8" fill="#fff" />
      <g className={active ? "wos-emily-arcs" : undefined}>
        <path
          d="M24 8 a16 16 0 0 1 11.3 4.7"
          fill="none"
          stroke="rgba(255,255,255,.55)"
          strokeWidth="3.2"
          strokeLinecap="round"
        />
        <path
          d="M24 40 a16 16 0 0 1 -11.3 -4.7"
          fill="none"
          stroke="rgba(255,255,255,.55)"
          strokeWidth="3.2"
          strokeLinecap="round"
        />
      </g>
    </>
  );
}

export function Avatar({
  role,
  name,
  id,
  src,
  size,
  className,
  "aria-label": ariaLabel,
  active,
}: AvatarProps) {
  const numericSize = typeof size === "number" ? size : undefined;
  const sizeClass = typeof size === "string" ? size : undefined;
  const combinedClass = [sizeClass, className].filter(Boolean).join(" ") || undefined;

  const baseStyle: React.CSSProperties = {
    display: "block",
    flexShrink: 0,
    ...shapeStyle(role),
    ...(numericSize ? { width: numericSize, height: numericSize } : {}),
  };

  // Photo / logo override (user photo, workspace/worker logo). Emily is fixed.
  if (role !== "emily" && src) {
    const imgAlt = ariaLabel ?? "";
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={imgAlt}
        aria-hidden={imgAlt === "" ? true : undefined}
        referrerPolicy="no-referrer"
        className={combinedClass}
        style={{ ...baseStyle, objectFit: "cover" }}
        {...(numericSize ? { width: numericSize, height: numericSize } : {})}
      />
    );
  }

  const svgDims = numericSize ? { width: numericSize, height: numericSize } : {};
  const a11y = ariaLabel
    ? { role: "img" as const, "aria-label": ariaLabel }
    : { "aria-hidden": true as const };

  // Emily: solid accent-blue squircle + A4.
  if (role === "emily") {
    return (
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 48 48"
        {...svgDims}
        className={combinedClass}
        style={baseStyle}
        {...a11y}
      >
        <rect width="48" height="48" fill="var(--accent)" />
        <EmilyA4 active={active} />
      </svg>
    );
  }

  // Generated fallback (user circle / workspace+worker squircle).
  const { motif, c1, c2 } = generateMark(id || name || "?");
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 48 48"
      {...svgDims}
      className={combinedClass}
      style={baseStyle}
      {...a11y}
    >
      <rect width="48" height="48" fill={MARK_GROUND} />
      <MotifBody motif={motif} c1={c1} c2={c2} />
    </svg>
  );
}
