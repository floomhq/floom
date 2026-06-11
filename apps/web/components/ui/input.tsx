import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        // v4 flat system (APP-UI-V4-SPEC §1 rule #2):
        // - border from --bd-input token (none) — no hardcoded border
        // - fill: --bg-2 (spec: "Search inputs = --bg-2 fill, no border")
        // - focus: ring only, no border-color change
        "[border:var(--bd-input)] h-8 w-full min-w-0 rounded-[var(--radius-input)] bg-[var(--bg-2)] px-2.5 py-1 text-sm transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40",
        className
      )}
      {...props}
    />
  )
}

export { Input }
