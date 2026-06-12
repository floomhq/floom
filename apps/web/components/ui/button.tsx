import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // v4 flat system (APP-UI-V4-SPEC §1 rule #2): border comes from --bd-btn token (none).
  // No resting shadow on any button. Hover = bg lift only. Shadow-none is explicit
  // so Tailwind's @layer base `shadow-sm` reset doesn't re-apply.
  "group/button inline-flex shrink-0 items-center justify-center rounded-[var(--radius-button)] [border:var(--bd-btn)] bg-clip-padding text-sm font-medium whitespace-nowrap shadow-none transition-all duration-150 ease-[var(--ease)] outline-none select-none active:not-aria-[haspopup]:translate-y-px active:not-aria-[haspopup]:scale-[0.985] disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          // v4: primary = --primary fill, --solid-fg text, no border, no resting shadow.
          // Hover = bg lift (color-mix darkens the fill). --primary is near-black in light,
          // accent-blue in dark — both correct by token, never hardcoded per-mode.
          "bg-[var(--primary)] text-[var(--solid-fg)] hover:bg-[color-mix(in_srgb,var(--primary)_88%,black_12%)] active:not-aria-[haspopup]:bg-[color-mix(in_srgb,var(--primary)_80%,black_20%)]",
        outline:
          // v4: secondary-style outline = --bg-2 fill (not glass), no border.
          // Spec §1: "secondary = filled --bg-2 (no outline)". Kept as "outline" variant
          // name for call-site compat but restyled to filled bg-2 per spec.
          "bg-[var(--bg-2)] text-ink hover:bg-[var(--bg-3)] aria-expanded:bg-[var(--bg-3)]",
        secondary:
          // v4: secondary = --bg-2 fill, no border, no shadow.
          "bg-secondary text-secondary-foreground hover:bg-[var(--bg-3)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "text-[var(--ink-soft)] hover:bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] hover:text-ink aria-expanded:bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] aria-expanded:text-ink",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30",
        link: "text-[var(--accent)] underline-offset-4 hover:underline",
      },
      size: {
        default:
          "h-8 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-[var(--radius-button)] px-2 text-xs in-data-[slot=button-group]:rounded-[var(--radius-button)] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 rounded-[var(--radius-button)] px-2.5 text-[0.8rem] in-data-[slot=button-group]:rounded-[var(--radius-button)] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-9 gap-1.5 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        icon: "size-8",
        "icon-xs":
          "size-6 rounded-[var(--radius-button)] in-data-[slot=button-group]:rounded-[var(--radius-button)] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm":
          "size-7 rounded-[var(--radius-button)] in-data-[slot=button-group]:rounded-[var(--radius-button)]",
        "icon-lg": "size-9",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
