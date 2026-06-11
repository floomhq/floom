import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-[var(--radius-button)] border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap shadow-none transition-all duration-150 ease-[var(--ease)] outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px active:not-aria-[haspopup]:scale-[0.985] disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          // Phase 1 (Codex trap): primary button reads --primary (near-black), NOT --accent.
          // --accent is now #3E6FE0 (blue); using it here would turn all primary buttons blue.
          // Rule: primary = --primary fill + --solid-fg text, always.
          "border-[color-mix(in_srgb,var(--primary)_82%,black_18%)] bg-[var(--primary)] text-[var(--solid-fg)] shadow-btn hover:bg-[color-mix(in_srgb,var(--primary)_90%,black_10%)] hover:shadow-md active:not-aria-[haspopup]:shadow-sm [a]:hover:bg-[color-mix(in_srgb,var(--primary)_90%,black_10%)]",
        outline:
          "border-[var(--accent-line)] bg-[var(--glass-bg)] text-ink shadow-sm backdrop-blur-[10px] backdrop-saturate-[180%] hover:bg-[var(--bg-2)] hover:text-ink aria-expanded:bg-[var(--bg-2)] aria-expanded:text-ink",
        secondary:
          "border-line bg-secondary text-secondary-foreground shadow-sm hover:bg-[var(--bg-3)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "text-[var(--ink-soft)] hover:bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] hover:text-ink aria-expanded:bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] aria-expanded:text-ink",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:hover:bg-destructive/30 dark:focus-visible:ring-destructive/40",
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
