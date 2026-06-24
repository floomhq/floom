"use client";

import type { ReactNode } from "react";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { cn } from "@/lib/utils";

/**
 * InlineToolToken — the ONE inline "[logo] Name" highlight for a recognised tool.
 *
 * Single source of truth for how a detected integration renders next to prompt
 * text: a faint --bg-3 token carrying the real BrandLogo sprite + the tool name,
 * baseline-aligned so it sits inside flowing copy. This is the exact register the
 * marketing landing prompt box uses (V3Body `ToolHl`), so the in-app surfaces can
 * never drift back into a different chip treatment.
 *
 * Used by:
 *   - PromptTokens (EmilyHomeEmpty) — inline highlight inside example prompt copy.
 *   - PromptChips — the "Uses / Will use" row under a composer (Emily, /workers/new).
 *
 * `icon` is the fallback glyph for non-connection capabilities (web-search,
 * schedule, email-send) which have no brand logo. `trailing` carries an optional
 * remove affordance for the removable chip-row variant.
 */
export function InlineToolToken({
  brand,
  icon,
  trailing,
  className,
  children,
}: {
  /** BrandLogo sprite slug for connections. Null/omitted for capabilities. */
  brand?: string | null;
  /** Fallback glyph for capabilities (no brand logo). */
  icon?: ReactNode;
  /** Optional trailing node, e.g. a remove button for the chip-row variant. */
  trailing?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-[3px] rounded-[var(--radius-ui)] bg-[var(--bg-3)] px-[5px] py-px align-baseline text-ink",
        className,
      )}
    >
      {brand ? (
        <BrandLogo icon={brand} className="size-[13px] shrink-0 translate-y-[1px]" />
      ) : icon ? (
        <span className="inline-flex size-[13px] shrink-0 translate-y-[1px] items-center justify-center text-muted-foreground">
          {icon}
        </span>
      ) : null}
      <span>{children}</span>
      {trailing}
    </span>
  );
}
