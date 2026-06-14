import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[var(--radius-ui)] px-2 py-0.5 text-xs font-medium whitespace-nowrap shadow-none transition-all duration-150 ease-[var(--ease)] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        primary:
          "bg-[var(--accent)] text-[var(--solid-fg)] [a]:hover:bg-[color-mix(in_srgb,var(--accent)_90%,var(--solid)_10%)]",
        default:
          "bg-[var(--accent-soft)] text-[var(--accent)] [a]:hover:bg-[var(--accent-soft)]",
        secondary:
          "bg-[var(--bg-2)] text-[var(--ink-soft)] [a]:hover:bg-[var(--bg-3)]",
        destructive:
          "bg-destructive/10 text-destructive dark:bg-destructive/20 [a]:hover:bg-destructive/20",
        outline:
          "bg-[var(--glass-bg)] text-[var(--ink-soft)] [a]:hover:bg-[var(--accent-soft)] [a]:hover:text-[var(--accent)]",
        ghost:
          "text-[var(--ink-soft)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]",
        link: "text-[var(--accent)] underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function statusToneClass(className: unknown) {
  if (typeof className !== "string") return undefined
  if (className.includes("emerald")) {
    return "bg-[color-mix(in_srgb,var(--positive)_11%,transparent)] text-[var(--positive)]"
  }
  if (className.includes("amber")) {
    return "bg-[var(--bg-2)] text-[var(--ink-soft)]"
  }
  if (className.includes("red")) {
    return "bg-[color-mix(in_srgb,var(--negative)_10%,transparent)] text-[var(--negative)]"
  }
  if (className.includes("blue")) {
    return "bg-[var(--accent-soft)] text-[var(--accent)]"
  }
  if (className.includes("gray")) {
    return "bg-[color-mix(in_srgb,var(--paper)_44%,transparent)] text-[var(--ink-mute)]"
  }
  return undefined
}

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className, statusToneClass(className)),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
