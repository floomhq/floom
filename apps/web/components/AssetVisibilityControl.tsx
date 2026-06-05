"use client";

import { useEffect, useState } from "react";
import { Lock, Users, ChevronDown, Check } from "lucide-react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  // M62: pending visibility change waiting for modal confirmation.
  const [pendingVis, setPendingVis] = useState<Vis | null>(null);

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

  const apply = async (nextVis: Vis) => {
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

  // M62: intercept the dropdown selection — Share→Private requires a confirm
  // modal because it can break existing shared links. Share→Shared is safe, no modal.
  const handleSelect = (next: Vis) => {
    if (next === value) return;
    // Any direction change gets a modal: switching to "private" warns about
    // breaking shared links; switching to "workspace" confirms the share action.
    setPendingVis(next);
  };

  return (
    <>
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
                  onClick={() => handleSelect(key)}
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

      {/* M62: confirm modal for visibility changes */}
      <Dialog open={pendingVis !== null} onOpenChange={(open) => { if (!open) setPendingVis(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pendingVis === "private"
                ? `Make this ${noun} private?`
                : `Share this ${noun} with your workspace?`}
            </DialogTitle>
            <DialogDescription>
              {pendingVis === "private"
                ? `This will make the ${noun} private. Anyone with an existing shared link will lose access — existing links will stop working.`
                : `This will share the ${noun} with everyone in your workspace. They will be able to see and use it.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingVis(null)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button
              variant={pendingVis === "private" ? "destructive" : "default"}
              disabled={saving}
              onClick={() => {
                if (pendingVis) {
                  void apply(pendingVis);
                }
                setPendingVis(null);
              }}
            >
              {saving ? "Saving…" : pendingVis === "private" ? "Make private" : "Share with workspace"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
