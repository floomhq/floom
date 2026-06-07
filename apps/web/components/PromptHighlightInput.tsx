"use client";

/**
 * PromptHighlightInput — a <textarea> with inline tool-name highlights.
 *
 * A plain <textarea> cannot render styled inline children, so this component
 * uses the CSS-grid stacking pattern:
 *
 *   1. A wrapper div with `display: grid` — both children occupy grid-area 1/1.
 *   2. An invisible mirror div (aria-hidden, pointer-events-none) renders the
 *      same text as highlighted <span> segments via the shared tokeniser. It
 *      drives the wrapper height so both elements grow in sync.
 *   3. The real <textarea> is stacked on top in the same grid cell with
 *      `text-transparent` — cursor and selection remain visible; the mirror
 *      text shows through beneath.
 *
 * Detection uses the ONE shared tokeniser from `lib/prompt-detect` — same
 * engine as PromptText (example cards) and PromptChips (chip row), so inline
 * highlight, chips, and backend wiring always agree.
 */

import { forwardRef, type TextareaHTMLAttributes } from "react";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { tokenisePrompt } from "@/lib/prompt-detect";
import { cn } from "@/lib/utils";

// Classes that BOTH the mirror div and the textarea share so their text stays
// pixel-aligned. Must match line-height, font-size, and padding exactly.
// Note: `whitespace-pre-wrap` + `break-words` mirrors textarea's wrapping.
const SHARED_CELL =
  "min-h-[160px] w-full resize-none text-base leading-relaxed px-0 py-0 font-[inherit] whitespace-pre-wrap break-words overflow-hidden";

type PromptHighlightInputProps = Omit<
  TextareaHTMLAttributes<HTMLTextAreaElement>,
  "value" | "onChange"
> & {
  value: string;
  onChange: (value: string) => void;
};

export const PromptHighlightInput = forwardRef<
  HTMLTextAreaElement,
  PromptHighlightInputProps
>(function PromptHighlightInput(
  { value, onChange, className, ...rest },
  ref,
) {
  const segments = tokenisePrompt(value);

  return (
    // CSS grid: both children sit in the same cell (row 1, col 1).
    // The mirror drives height; the textarea stretches to match.
    <div
      className={cn("grid", className)}
      style={{ gridTemplateColumns: "1fr", gridTemplateRows: "1fr" }}
    >
      {/* Mirror layer — in-flow so it drives the wrapper height.
          aria-hidden + pointer-events-none: purely visual. */}
      <div
        aria-hidden="true"
        className={cn(SHARED_CELL, "col-start-1 row-start-1 text-foreground pointer-events-none select-none")}
      >
        {value ? (
          <span>
            {segments.map((seg, i) => {
              if (seg.kind === "plain") {
                return <span key={i}>{seg.text}</span>;
              }
              return (
                <span
                  key={i}
                  className="inline-flex items-baseline gap-[3px] rounded-[4px] bg-muted/50 px-[5px] py-[1px] mx-[1px] align-baseline whitespace-nowrap"
                >
                  {seg.brand && (
                    <BrandLogo
                      icon={seg.brand}
                      className="size-[13px] shrink-0 translate-y-[1px]"
                    />
                  )}
                  <span>{seg.text}</span>
                </span>
              );
            })}
          </span>
        ) : (
          // When empty: invisible stand-in keeps the same height as placeholder text.
          <span className="invisible" aria-hidden="true">
            {rest.placeholder ?? " "}
          </span>
        )}
      </div>

      {/* The real textarea — stacked in the same grid cell as the mirror.
          `text-transparent` hides typed text so the mirror shows through.
          `caret-color` uses the CSS foreground token so the cursor remains
          visible in both light and dark mode. */}
      <textarea
        ref={ref}
        {...rest}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          SHARED_CELL,
          "col-start-1 row-start-1 border-0 bg-transparent shadow-none outline-none",
          "text-transparent caret-[hsl(var(--foreground))]",
          "focus-visible:ring-0 focus-visible:border-0",
          "placeholder:text-muted-foreground/50",
          "disabled:cursor-not-allowed disabled:opacity-50",
          "z-10",
        )}
      />
    </div>
  );
});
