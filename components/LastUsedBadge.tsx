import type { CSSProperties } from "react";

// "Last used" pill, anchored to the top-right edge of an auth button. Inline
// styles (not a CSS class) so it drops into any auth surface — the apex /login
// and the dashboard /app/login use different stylesheets. Colors resolve from
// the shared --success / --bg-card design tokens, with literal fallbacks.
const badgeStyle: CSSProperties = {
  position: "absolute",
  top: -9,
  right: 12,
  display: "inline-flex",
  alignItems: "center",
  padding: "2px 8px",
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: "0.05em",
  textTransform: "uppercase",
  lineHeight: 1.4,
  whiteSpace: "nowrap",
  pointerEvents: "none",
  color: "var(--success, #207346)",
  background: "color-mix(in srgb, var(--success, #207346) 14%, var(--bg-card, #ffffff))",
  border: "1px solid color-mix(in srgb, var(--success, #207346) 32%, transparent)",
};

export function LastUsedBadge() {
  return <span style={badgeStyle}>Last used</span>;
}
