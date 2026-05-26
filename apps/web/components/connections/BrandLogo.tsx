import { Plug } from "lucide-react";
import { cn } from "@/lib/utils";

const BRAND_COLORS: Record<string, string> = {
  composio: "text-[#111111]",
  github: "text-[#181717]",
  gmail: "text-[#EA4335]",
  "google-calendar": "text-[#1A73E8]",
  "google-drive": "text-[#1E8E3E]",
  hubspot: "text-[#FF5C35]",
  linear: "text-[#5E6AD2]",
  notion: "text-[#111111]",
  salesforce: "text-[#00A1E0]",
};

export function BrandLogo({
  icon,
  className,
}: {
  icon: string;
  className?: string;
}) {
  const symbolId = `brand-${icon}`;
  if (!icon) {
    return <Plug className={cn("size-5 text-[var(--ink-mute)]", className)} />;
  }

  return (
    <svg
      className={cn("size-5", BRAND_COLORS[icon] ?? "text-[var(--ink)]", className)}
      role="img"
      aria-hidden="true"
      focusable="false"
    >
      <use href={`#${symbolId}`} />
    </svg>
  );
}
