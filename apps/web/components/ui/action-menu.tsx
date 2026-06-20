"use client"

import * as React from "react"
import { MoreHorizontal } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { IconButton } from "@/components/ui/icon-button"
import { ConfirmDialog, type ConfirmDialogProps } from "@/components/ui/confirm-dialog"

export interface ActionMenuItem {
  label: React.ReactNode
  icon?: React.ReactNode
  onSelect: () => void
  /** Apply the destructive token to this item. */
  destructive?: boolean
  disabled?: boolean
  /**
   * When set, selecting the item opens the shared `ConfirmDialog` instead of
   * running `onSelect` immediately. `onSelect` runs on confirm.
   */
  confirm?: Pick<
    ConfirmDialogProps,
    | "title"
    | "body"
    | "confirmLabel"
    | "cancelLabel"
    | "destructive"
    | "requireTypedConfirmation"
  >
}

export interface ActionMenuProps {
  /** Accessible label for the trigger (e.g. "More worker actions"). */
  label: string
  items: ActionMenuItem[]
  align?: "start" | "end" | "center"
  /** Override the trigger element (defaults to a ghost ⋯ IconButton). */
  trigger?: React.ReactElement
  contentClassName?: string
}

/**
 * Global overflow / "⋯" menu. The single replacement for both the hand-rolled
 * `c-menu` state machine and the ad-hoc `DropdownMenu` call sites. Trigger is a
 * shared `IconButton` (MoreHorizontal). Destructive items get the destructive
 * token; items with `confirm` route through the shared `ConfirmDialog` instead
 * of `window.confirm`.
 */
function ActionMenu({
  label,
  items,
  align = "end",
  trigger,
  contentClassName = "w-44 p-1",
}: ActionMenuProps) {
  const [confirmFor, setConfirmFor] = React.useState<ActionMenuItem | null>(null)

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            trigger ?? (
              <IconButton
                icon={<MoreHorizontal />}
                label={label}
                tooltip={null}
              />
            )
          }
        />
        <DropdownMenuContent align={align} className={contentClassName}>
          {items.map((item, i) => (
            <DropdownMenuItem
              key={i}
              variant={item.destructive ? "destructive" : "default"}
              disabled={item.disabled}
              onClick={() => {
                if (item.confirm) setConfirmFor(item)
                else item.onSelect()
              }}
            >
              {item.icon}
              {item.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      {confirmFor?.confirm && (
        <ConfirmDialog
          open={confirmFor != null}
          onOpenChange={(o) => {
            if (!o) setConfirmFor(null)
          }}
          title={confirmFor.confirm.title}
          body={confirmFor.confirm.body}
          confirmLabel={confirmFor.confirm.confirmLabel}
          cancelLabel={confirmFor.confirm.cancelLabel}
          destructive={confirmFor.confirm.destructive ?? confirmFor.destructive}
          requireTypedConfirmation={confirmFor.confirm.requireTypedConfirmation}
          onConfirm={() => {
            const item = confirmFor
            setConfirmFor(null)
            item.onSelect()
          }}
        />
      )}
    </>
  )
}

export { ActionMenu }
