/** Seeded avatar (initials + deterministic hue) for items without a brand logo. */
const PALETTE = ["#3E6FE0", "#4B5563", "#2563EB", "#64748B", "#5B8DEF", "#0F766E", "#334155"];

function seedColor(s: string): string {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function initials(name: string): string {
  return (
    name
      .replace(/[^A-Za-z ]/g, "")
      .split(" ")
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?"
  );
}

export function Avatar({ name, size = 30 }: { name: string; size?: number }) {
  return (
    <span
      className="c-av"
      style={{ width: size, height: size, background: seedColor(name) }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}
