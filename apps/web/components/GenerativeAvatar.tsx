/**
 * GenerativeAvatar — deterministic, SSR-safe inline SVG avatar.
 *
 * Algorithm ported from /root/gensys.html draw() function.
 * Same seed always produces identical SVG output (no random, no useEffect,
 * no canvas). Shape grammar: circle = human user, squircle = workspace + AI worker.
 *
 * Override ladder: when avatarUrl is present, renders <img> cropped to the
 * shape instead of the generated SVG.
 */

export const GENERATIVE_AVATAR_PALETTES: readonly (readonly [
  string,
  string,
  string,
])[] = [
  ["#6D5DF6", "#22D3EE", "#F472B6"],
  ["#F59E0B", "#EF4444", "#8B5CF6"],
  ["#10B981", "#3B82F6", "#A3E635"],
  ["#FB7185", "#FBBF24", "#34D399"],
  ["#3E6FE0", "#9333EA", "#06B6D4"],
  ["#EC4899", "#8B5CF6", "#3B82F6"],
];

/**
 * djb2-style hash matching gensys.html hash(s).
 * Returns a non-negative integer deterministically from s.
 */
export function genAvatarHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h);
}

export interface GenerativeAvatarProps {
  /** Deterministic seed — same seed always produces the same avatar. */
  seed: string;
  /** circle = human user; squircle = workspace / AI worker. */
  shape: "circle" | "squircle";
  /**
   * Numeric pixel size sets explicit SVG width/height.
   * A string value is applied as a className (e.g. Tailwind "size-7").
   */
  size?: number | string;
  /**
   * When set, renders an <img> cropped to the shape rather than the
   * generated SVG (the override). null/undefined falls through to generated.
   */
  avatarUrl?: string | null;
  /** Optional fixed 3-color palette, overrides the seed-derived one. */
  palette?: readonly [string, string, string];
  className?: string;
  /** Alt text for the img override. Defaults to "" (aria-hidden). */
  alt?: string;
  /** Accessible label for the SVG (or img). When omitted, the element is aria-hidden. */
  "aria-label"?: string;
}

export function GenerativeAvatar({
  seed,
  shape,
  size,
  avatarUrl,
  palette,
  className,
  alt = "",
  "aria-label": ariaLabel,
}: GenerativeAvatarProps) {
  const numericSize = typeof size === "number" ? size : null;
  const sizeClass = typeof size === "string" ? size : null;
  const borderRadius =
    shape === "circle" ? "9999px" : "var(--radius-squircle)";

  const baseStyle: React.CSSProperties = {
    display: "block",
    flexShrink: 0,
    borderRadius,
    ...(numericSize ? { width: numericSize, height: numericSize } : {}),
  };

  const combinedClass = [sizeClass, className].filter(Boolean).join(" ") || undefined;

  // Override: avatarUrl present → img cropped to shape.
  if (avatarUrl) {
    const imgAlt = ariaLabel ?? alt;
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={avatarUrl}
        alt={imgAlt}
        aria-hidden={imgAlt === "" ? true : undefined}
        referrerPolicy="no-referrer"
        className={combinedClass}
        style={{ ...baseStyle, objectFit: "cover" }}
        {...(numericSize ? { width: numericSize, height: numericSize } : {})}
      />
    );
  }

  // Generated SVG path.
  const h = genAvatarHash(seed);
  const pal: readonly [string, string, string] =
    palette ?? GENERATIVE_AVATAR_PALETTES[h % GENERATIVE_AVATAR_PALETTES.length];

  // Per-instance id prefix (derived from seed, no random) prevents DOM id collisions.
  const uid = `ga-${(h >>> 0).toString(36)}`;
  const clipId = `${uid}-clip`;
  const filterId = `${uid}-blur`;
  const gradId = `${uid}-g`;

  // SVG coordinate space is 100×100; width/height attrs scale it.
  const V = 100;
  const blur = V * 0.22;

  // Clip path: circle = arc, squircle = rounded-rect with corner radius 27%.
  const R = shape === "circle" ? V / 2 : V * 0.27;
  const clipD =
    shape === "circle"
      ? `M ${V / 2} 0 A ${V / 2} ${V / 2} 0 1 0 ${V / 2} ${V} A ${V / 2} ${V / 2} 0 1 0 ${V / 2} 0 Z`
      : `M ${R} 0 L ${V - R} 0 Q ${V} 0 ${V} ${R} L ${V} ${V - R} Q ${V} ${V} ${V - R} ${V} L ${R} ${V} Q 0 ${V} 0 ${V - R} L 0 ${R} Q 0 0 ${R} 0 Z`;

  // Three ellipses, each derived from seed+index (matching gensys.html loop).
  const ellipses = [0, 1, 2].map((i) => {
    const hx = genAvatarHash(seed + i);
    const cx = ((hx % 100) / 100) * V;
    const cy = (((hx >> 7) % 100) / 100) * V;
    const rx = V * 0.5;
    const ry = V * 0.42;
    const deg = hx % 360;
    const color = pal[(hx >> 3) % pal.length];
    return (
      <ellipse
        key={i}
        cx={cx}
        cy={cy}
        rx={rx}
        ry={ry}
        fill={color}
        filter={`url(#${filterId})`}
        transform={`rotate(${deg} ${cx} ${cy})`}
      />
    );
  });

  const svgDims = numericSize
    ? { width: numericSize, height: numericSize }
    : {};

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${V} ${V}`}
      {...svgDims}
      className={combinedClass}
      style={baseStyle}
      aria-hidden={ariaLabel ? undefined : true}
      aria-label={ariaLabel}
      role={ariaLabel ? "img" : undefined}
    >
      <defs>
        <filter id={filterId} x="-60%" y="-60%" width="220%" height="220%">
          <feGaussianBlur stdDeviation={blur} />
        </filter>
        <clipPath id={clipId}>
          <path d={clipD} />
        </clipPath>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="rgba(255,255,255,0.22)" />
          <stop offset="0.5" stopColor="rgba(255,255,255,0)" />
        </linearGradient>
      </defs>
      <g clipPath={`url(#${clipId})`}>
        {/* Base background */}
        <rect x="0" y="0" width={V} height={V} fill={pal[0]} />
        {/* Blurred colour ellipses */}
        {ellipses}
        {/* Glass highlight */}
        <rect x="0" y="0" width={V} height={V} fill={`url(#${gradId})`} />
      </g>
    </svg>
  );
}
