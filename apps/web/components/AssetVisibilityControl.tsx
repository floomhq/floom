"use client";

import { useEffect, useState } from "react";
import { Lock, Users, ChevronDown, Check } from "lucide-react";
import { toast } from "sonner";
import { buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import type { AssetVisibility } from "@/lib/types";

/**
 * Generic Private <-> Shared (workspace) visibility control, shared across every
 * asset type (workers, brain packs, the assistant) so all assets get the IDENTICAL
 * Share affordance. Follows the Notion/Figma share convention: a quiet trigger
 * showing the current state, opening a small menu to pick visibility.
 *
 * `specific_people` is reserved server-side but hidden here until asset-grants ship.
 * On the OSS single-owner engine this still renders (one-member workspace), so OS
 * and Cloud look identical. Hidden (button variant) when the user cannot share.
 *
 * Pass `noun` (e.g. "worker", "brain pack", "assistant") so the labels/hints read
 * correctly for each asset. `onApply` performs the PUT and returns the new
 * visibility (or throws); the control owns the optimistic state + toast.
 */

type Vis = "private" | "workspace";

function meta(noun: string): Record<Vis, { label: string; icon: typeof Lock; hint: string }> {
  return {
    private: {
      label: "Private",
      icon: Lock,
      hint: `Only you can see and use this ${noun}.`,
    },
    workspace: {
      label: "Shared",
      icon: Users,
      hint: `Everyone in your workspace can see and use this ${noun}.`,
    },
  };
}

function normalize(v: AssetVisibility | undefined): Vis {
  return v === "workspace" ? "workspace" : "private";
}

export function AssetVisibilityIndicator({
  visibility,
  noun = "asset",
}: {
  visibility?: AssetVisibility;
  noun?: string;
}) {
  const key = normalize(visibility);
  const m = meta(noun)[key];
  const Icon = m.icon;
  return (
    <span
      title={m.hint}
      aria-label={`Visibility: ${m.label}`}
      className="inline-flex items-center gap-1 text-[10px] font-normal leading-none text-[var(--ink-mute)]"
    >
      <Icon className="size-3" />
      {m.label}
    </span>
  );
}

export function AssetVisibilityControl({
  visibility,
  canShare,
  noun = "asset",
  titleLabel,
  onApply,
  variant = "button",
}: {
  visibility?: AssetVisibility;
  canShare: boolean;
  noun?: string;
  /** Dropdown header, e.g. "Brain pack visibility". Defaults from noun. */
  titleLabel?: string;
  /** Performs the PUT; resolves to the new visibility (or throws). */
  onApply: (next: Vis) => Promise<AssetVisibility | void>;
  variant?: "button" | "indicator";
}) {
  const current = normalize(visibility);
  const [value, setValue] = useState<Vis>(current);
  const [saving, setSaving] = useState(false);

  // Keep in sync when the parent re-fetches and hands a new visibility.
  useEffect(() => {
    setValue(normalize(visibility));
  }, [visibility]);

  if (variant === "indicator" || !canShare) {
    return <AssetVisibilityIndicator visibility={visibility} noun={noun} />;
  }

  const VIS = meta(noun);
  const m = VIS[value];
  const Icon = m.icon;

  const apply = async (next: string) => {
    const nextVis: Vis = next === "workspace" ? "workspace" : "private";
    if (nextVis === value) return;
    const prev = value;
    setValue(nextVis);
    setSaving(true);
    try {
      await onApply(nextVis);
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
        disabled={saving}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          "shrink-0",
        )}
      >
        <Icon className="size-3.5" />
        {m.label}
        <ChevronDown className="size-3.5 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {titleLabel ?? `${noun[0].toUpperCase()}${noun.slice(1)} visibility`}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          {(["private", "workspace"] as const).map((key) => {
            const im = VIS[key];
            const ItemIcon = im.icon;
            const active = value === key;
            return (
              <DropdownMenuItem
                key={key}
                onClick={() => void apply(key)}
                className={`flex-col items-start gap-0.5 py-2 ${active ? "bg-[var(--active-nav-bg)]" : ""}`}
              >
                <span className="flex w-full items-center gap-1.5 text-sm font-medium text-foreground">
                  <ItemIcon className="size-3.5 text-foreground" />
                  {im.label}
                  {active && <Check className="size-3.5 ml-auto text-foreground" />}
                </span>
                <span className="text-xs text-muted-foreground">{im.hint}</span>
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
