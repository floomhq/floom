import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
  function Textarea({ className, ...props }, ref) {
    return (
      <textarea
        ref={ref}
        data-slot="textarea"
        className={cn(
          // v4 flat system (APP-UI-V4-SPEC §1 rule #2): border from --bd-input (none), fill --bg-2.
          "[border:var(--bd-input)] flex field-sizing-content min-h-16 w-full rounded-[var(--radius-input)] bg-[var(--bg-2)] px-2.5 py-2 text-sm transition-colors outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
        {...props}
      />
    )
  }
)

export { Textarea }
