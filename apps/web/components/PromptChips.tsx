"use client";

/**
 * PromptChips — chip row rendered directly UNDER a prompt box.
 *
 * A <textarea> can't carry rich inline highlights for what the user types, so
 * the pattern is: detect the tools + capabilities in the live prompt text with
 * the ONE shared detector (`lib/prompt-detect`) and surface them as a row of
 * chips below the box. Each chip is PRE-SELECTED (the worker will wire it up)
 * and REMOVABLE (operator can drop one before generating).
 *
 * Connections render their real brand logo (BrandLogo sprite); capabilities
 * render a small lucide glyph. Each chip is the SHARED InlineToolToken — the
 * exact "[logo] Name" inline highlight the marketing landing prompt box uses —
 * so the composer chip row and the landing/home inline tokens can never drift
 * into divergent treatments again. No coloured badges, no bordered pills.
 *
 * Used under every prompt box: /workers/new, the /workers landing hero, and the
 * Emily assistant composer. One component, every surface (DRY).
 */

import { useMemo } from "react";
import { Globe, Clock, Mail, X, type LucideIcon } from "lucide-react";
import { InlineToolToken } from "@/components/InlineToolToken";
import { detectPromptItems } from "@/lib/prompt-detect";
import { cn } from "@/lib/utils";

const CAPABILITY_ICONS: Record<string, LucideIcon> = {
  "web-search": Globe,
  schedule: Clock,
  "email-send": Mail,
};

export function PromptChips({
  prompt,
  dismissed,
  onDismiss,
  className,
}: {
  /** Live prompt text to scan. */
  prompt: string;
  /**
   * Ids the operator has removed. Optional — when omitted the row is read-only
   * (no remove buttons), e.g. on example cards.
   */
  dismissed?: ReadonlySet<string>;
  /** Called with the chip id when the operator removes a chip. */
  onDismiss?: (id: string) => void;
  className?: string;
}) {
  const items = useMemo(() => detectPromptItems(prompt), [prompt]);
  const visible = items.filter((it) => !dismissed?.has(it.id));

  if (visible.length === 0) return null;

  const removable = typeof onDismiss === "function";

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5", className)}>
      <span className="text-[11px] text-muted-foreground mr-0.5">
        {removable ? "Will use" : "Uses"}
      </span>
      {visible.map((it) => {
        const CapIcon = it.kind === "capability" ? CAPABILITY_ICONS[it.id] : undefined;
        return (
          <InlineToolToken
            key={it.id}
            brand={it.brand}
            icon={CapIcon ? <CapIcon className="size-[13px]" /> : undefined}
            className="text-xs"
            trailing={
              removable ? (
                <button
                  type="button"
                  onClick={() => onDismiss?.(it.id)}
                  className="ml-0.5 inline-flex size-3.5 translate-y-[1px] items-center justify-center rounded-[var(--radius-pill)] text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                  aria-label={`Remove ${it.label}`}
                >
                  <X className="size-3" />
                </button>
              ) : undefined
            }
          >
            {it.label}
          </InlineToolToken>
        );
      })}
    </div>
  );
}
