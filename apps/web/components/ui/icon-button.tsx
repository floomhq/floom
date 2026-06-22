"use client"

import * as React from "react"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import type { VariantProps } from "class-variance-authority"

type ButtonVariant = VariantProps<typeof buttonVariants>["variant"]
type IconSize = "icon-xs" | "icon-sm" | "icon" | "icon-lg"

export interface IconButtonProps
  extends Omit<React.ComponentProps<typeof Button>, "size" | "children"> {
  /** The icon node (a lucide icon element). */
  icon: React.ReactNode
  /** Accessible label — REQUIRED. Used for aria-label and (by default) the tooltip. */
  label: string
  /** Tooltip text. Defaults to `label`. Pass `null` to disable the tooltip. */
  tooltip?: React.ReactNode | null
  /** Icon-button size. Defaults to `icon-sm` (size-7, ≥28px hit-area). */
  size?: IconSize
  variant?: ButtonVariant
  /** Toggle/pressed state — sets aria-pressed. */
  pressed?: boolean
}

/**
 * Global icon-only button. Standardizes hit-area, mandatory aria-label, and an
 * optional shared tooltip. Replaces every bespoke raw `<button>` icon control
 * (`.star`, `.x`, `.c-vtog` buttons, pagination chevrons, paperclip, etc.).
 *
 * Always renders via the canonical `Button` (DS tokens, no border, --radius-button),
 * so icon buttons inherit the flat-v4 system with zero per-call CSS.
 */
function IconButton({
  icon,
  label,
  tooltip,
  size = "icon-sm",
  variant = "ghost",
  pressed,
  type = "button",
  ...props
}: IconButtonProps) {
  if (tooltip === null) {
    return (
      <Button
        type={type}
        variant={variant}
        size={size}
        aria-label={label}
        aria-pressed={pressed}
        {...props}
      >
        {icon}
      </Button>
    )
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type={type}
              variant={variant}
              size={size}
              aria-label={label}
              aria-pressed={pressed}
              {...props}
            />
          }
        >
          {icon}
        </TooltipTrigger>
        <TooltipContent>{tooltip ?? label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

export { IconButton }
