"use client"

import * as React from "react"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"

export interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: React.ReactNode
  /** Body copy (the consequence). */
  body?: React.ReactNode
  /** Confirm button label. Defaults to "Confirm". */
  confirmLabel?: string
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string
  /** Destructive styling on the confirm button. */
  destructive?: boolean
  /**
   * When set, the confirm button stays disabled until the user types this exact
   * string (the settings Danger-zone pattern). Use for irreversible actions.
   */
  requireTypedConfirmation?: string
  /** Disable the confirm button (e.g. while the action is in flight). */
  loading?: boolean
  onConfirm: () => void
}

/**
 * Global confirmation dialog. The single replacement for every `window.confirm`
 * (off-brand native dialog). Wraps the canonical `Dialog`, uses DS tokens, and
 * supports the typed-confirmation pattern from the settings Danger zone.
 */
function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  requireTypedConfirmation,
  loading = false,
  onConfirm,
}: ConfirmDialogProps) {
  const [typed, setTyped] = React.useState("")

  // Reset the typed value whenever the dialog opens.
  React.useEffect(() => {
    if (open) setTyped("")
  }, [open])

  const typedOk =
    !requireTypedConfirmation || typed.trim() === requireTypedConfirmation

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className={destructive ? "text-destructive" : undefined}>
            {title}
          </DialogTitle>
          {body != null && <DialogDescription>{body}</DialogDescription>}
        </DialogHeader>
        {requireTypedConfirmation && (
          <div className="space-y-2">
            <Label
              htmlFor="confirm-dialog-input"
              className="text-xs text-muted-foreground"
            >
              Type{" "}
              <code className="text-foreground">{requireTypedConfirmation}</code>{" "}
              to confirm.
            </Label>
            <Input
              id="confirm-dialog-input"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={requireTypedConfirmation}
              autoComplete="off"
            />
          </div>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            {cancelLabel}
          </DialogClose>
          <Button
            variant={destructive ? "destructive" : "default"}
            disabled={loading || !typedOk}
            onClick={() => onConfirm()}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export { ConfirmDialog }
