import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-[var(--r-pill)] border px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all duration-150 ease-[var(--ease)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default:
          "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)] [a]:hover:bg-[var(--accent-soft)]",
        secondary:
          "border-line bg-[var(--bg-2)] text-[var(--ink-soft)] [a]:hover:bg-[var(--bg-3)]",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20",
        outline:
          "border-line bg-[var(--glass-bg)] text-[var(--ink-soft)] [a]:hover:bg-[var(--accent-soft)] [a]:hover:text-[var(--accent)]",
        ghost:
          "border-transparent text-[var(--ink-soft)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)]",
        link: "border-transparent text-[var(--accent)] underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

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
        className: cn(badgeVariants({ variant }), className),
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
