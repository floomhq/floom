// Emily radar mark — the home hero glyph (v6 spec). Two variants:
//   - "ink"    : monochrome (state A first-worker hero), drawn in --ink at low
//                opacity so the only blue at rest is the composer's mini mark.
//   - "accent" : the live Emily-blue mark used inside the composer + Emily turns.
// SVG-only, theme-aware via the --ink / --emily-mark tokens. No emoji, no image.

export function EmilyRadarMark({
  size = 46,
  variant = "ink",
}: {
  size?: number;
  variant?: "ink" | "accent";
}) {
  if (variant === "accent") {
    return (
      <span className="inline-flex items-center justify-center" aria-hidden="true">
        <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
          <circle cx="24" cy="24" r="21" stroke="var(--emily-mark)" strokeWidth="2" strokeOpacity=".30" />
          <circle cx="24" cy="24" r="13.5" stroke="var(--emily-mark)" strokeWidth="2" strokeOpacity=".55" />
          <path d="M24 24 L24 3 A21 21 0 0 1 42.18 13.5 Z" fill="var(--emily-mark)" fillOpacity=".16" />
          <line x1="24" y1="24" x2="42.18" y2="13.5" stroke="var(--emily-mark)" strokeWidth="2" strokeLinecap="round" />
          <circle cx="24" cy="24" r="4.5" fill="var(--emily-mark)" />
        </svg>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center justify-center" aria-hidden="true">
      <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
        <circle cx="24" cy="24" r="21" stroke="var(--ink)" strokeWidth="1.5" strokeOpacity=".18" />
        <circle cx="24" cy="24" r="14" stroke="var(--ink)" strokeWidth="1.5" strokeOpacity=".32" />
        <circle cx="24" cy="24" r="7" stroke="var(--ink)" strokeWidth="1.5" strokeOpacity=".55" />
        <path d="M24 24 L24 3 A21 21 0 0 1 42.18 13.5 Z" fill="var(--ink)" fillOpacity=".06" />
        <line x1="24" y1="24" x2="42.18" y2="13.5" stroke="var(--ink)" strokeWidth="1.5" strokeLinecap="round" strokeOpacity=".6" />
        <circle cx="24" cy="24" r="3" fill="var(--ink)" fillOpacity=".7" />
      </svg>
    </span>
  );
}
