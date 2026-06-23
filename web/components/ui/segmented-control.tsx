"use client"

import * as React from "react"
import { cn } from "@/lib/utils"

export interface SegmentedOption<V extends string> {
  value: V
  /** Visible label (used as aria-label when only an icon is shown). */
  label: string
  icon?: React.ReactNode
  /** Hide the text label, show only the icon (label still drives aria-label). */
  iconOnly?: boolean
}

export interface SegmentedControlProps<V extends string> {
  options: SegmentedOption<V>[]
  value: V
  onChange: (value: V) => void
  size?: "sm" | "default"
  className?: string
  /** Accessible group label. */
  ariaLabel?: string
}

/**
 * Global filled-track segmented control. One implementation of "pick one of N"
 * (the `.c-vtog` / `ThemeModeToggleGroup` shape). Underline tabs keep `Tabs`;
 * this is for compact 2-3 option toggles (view mode, theme mode).
 *
 * Tokens only: --bg-2 track, --bg-card active fill, --radius-button. No border.
 */
function SegmentedControl<V extends string>({
  options,
  value,
  onChange,
  size = "default",
  className,
  ariaLabel,
}: SegmentedControlProps<V>) {
  const seg =
    size === "sm" ? "h-6 min-w-7 px-2 text-xs" : "h-[26px] min-w-[30px] px-2.5 text-xs"
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        "inline-flex rounded-[var(--radius-button)] bg-[var(--bg-2)] p-0.5",
        className
      )}
    >
      {options.map((opt) => {
        const active = opt.value === value
        return (
          <button
            key={opt.value}
            type="button"
            aria-label={opt.iconOnly ? opt.label : undefined}
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-[calc(var(--radius-button)-1px)] font-medium transition-[background,color] duration-100 [&_svg]:size-3.5",
              seg,
              active
                ? "bg-[var(--bg-card)] text-[var(--ink)]"
                : "text-[var(--muted-foreground)] hover:text-[var(--ink)]"
            )}
          >
            {opt.icon}
            {!opt.iconOnly && <span>{opt.label}</span>}
          </button>
        )
      })}
    </div>
  )
}

export { SegmentedControl }
