"use client";

import { useState } from "react";
import { Lock, Users, ChevronDown, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/lib/api";
import type { AssetVisibility, WorkerDetail } from "@/lib/types";

/**
 * Visibility (Share) control for a worker: Private <-> Shared with workspace.
 *
 * Follows the Notion/Figma share-affordance convention — a quiet trigger showing
 * the current state, opening a small menu to pick visibility. `specific_people`
 * is reserved server-side but intentionally hidden here until asset-grants ship.
 *
 * On the OSS single-owner engine this still renders (one-member workspace), so
 * OS and Cloud look identical. Hidden entirely when the user cannot share
 * (can_share=false) or for read-only stock workers (no owner_id).
 *
 * Two surfaces:
 *  - `variant="button"` — full button for the worker detail header
 *  - `variant="indicator"` — compact read-only chip for the worker list cards
 */

const VISIBILITY_META: Record<
  Exclude<AssetVisibility, "specific_people">,
  { label: string; icon: typeof Lock; hint: string }
> = {
  private: {
    label: "Private",
    icon: Lock,
    hint: "Only you can see and run this worker.",
  },
  workspace: {
    label: "Shared",
    icon: Users,
    hint: "Everyone in your workspace can see and run this worker.",
  },
};

function normalize(v: AssetVisibility | undefined): "private" | "workspace" {
  return v === "workspace" ? "workspace" : "private";
}

export function WorkerVisibilityIndicator({
  visibility,
}: {
  visibility?: AssetVisibility;
}) {
  const key = normalize(visibility);
  const meta = VISIBILITY_META[key];
  const Icon = meta.icon;
  return (
    <span
      title={meta.hint}
      aria-label={`Visibility: ${meta.label}`}
      className="inline-flex items-center gap-1 text-[10px] font-normal leading-none text-[var(--ink-mute)]"
    >
      <Icon className="size-3" />
      {meta.label}
    </span>
  );
}

export function WorkerVisibilityControl({
  worker,
  onChange,
  variant = "button",
}: {
  worker: WorkerDetail;
  onChange?: (updated: WorkerDetail) => void;
  variant?: "button" | "indicator";
}) {
  const current = normalize(worker.visibility);
  const [value, setValue] = useState<"private" | "workspace">(current);
  const [saving, setSaving] = useState(false);

  // Read-only stock workers (no owner) or no share rights: render nothing
  // (button) or a static indicator only.
  const canShare = worker.permissions?.can_share ?? Boolean(worker.owner_id);

  if (variant === "indicator" || !canShare) {
    return <WorkerVisibilityIndicator visibility={worker.visibility} />;
  }

  const meta = VISIBILITY_META[value];
  const Icon = meta.icon;

  const apply = async (next: string) => {
    const nextVis = next === "workspace" ? "workspace" : "private";
    if (nextVis === value) return;
    const prev = value;
    setValue(nextVis);
    setSaving(true);
    try {
      const updated = await api.workers.setVisibility(worker.id, nextVis);
      onChange?.(updated);
      toast.success(
        nextVis === "workspace" ? "Shared with workspace" : "Set to private",
      );
    } catch (e: unknown) {
      setValue(prev);
      toast.error(e instanceof Error ? e.message : "Failed to update visibility");
    } finally {
      setSaving(false);
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm" disabled={saving} className="shrink-0">
            <Icon className="size-3.5" />
            {meta.label}
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>Worker visibility</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={value} onValueChange={apply}>
          {(["private", "workspace"] as const).map((key) => {
            const m = VISIBILITY_META[key];
            const ItemIcon = m.icon;
            const active = value === key;
            return (
              <DropdownMenuRadioItem
                key={key}
                value={key}
                className="flex-col items-start gap-0.5 py-2 [&>span:first-child]:hidden"
              >
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <ItemIcon className="size-3.5" />
                  {m.label}
                  {active && <Check className="size-3.5 text-foreground ml-auto" />}
                </span>
                <span className="text-xs text-muted-foreground">{m.hint}</span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
