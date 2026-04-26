/**
 * Shared SVG icons for Floom.
 * 
 * Design rule: Use Lucide-inspired 24x24 viewboxes with 
 * strokeWidth=2 and rounded caps. Icons should be semi-bold (strokeWidth=2)
 * to hold their own against the Inter UI typography.
 */

export function ExpandIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}
