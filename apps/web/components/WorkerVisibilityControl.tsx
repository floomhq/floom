"use client";

import { api } from "@/lib/api";
import type { AssetVisibility, WorkerDetail } from "@/lib/types";
import {
  AssetVisibilityControl,
  AssetVisibilityIndicator,
} from "@/components/AssetVisibilityControl";

/**
 * Worker visibility (Share) control — a thin wrapper over the shared
 * {@link AssetVisibilityControl} so workers, brain packs, and the assistant all
 * render the IDENTICAL Private <-> Shared affordance. The worker-specific bit is
 * just the PUT (`api.workers.setVisibility`) + the `onChange(updated)` callback.
 *
 * Read-only stock workers (no owner_id) or no share rights: render nothing
 * (button) or a static indicator only.
 */

export function WorkerVisibilityIndicator({
  visibility,
}: {
  visibility?: AssetVisibility;
}) {
  return <AssetVisibilityIndicator visibility={visibility} noun="worker" />;
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
  const canShare = worker.permissions?.can_share ?? Boolean(worker.owner_id);

  return (
    <AssetVisibilityControl
      visibility={worker.visibility}
      canShare={canShare}
      noun="worker"
      titleLabel="Worker visibility"
      variant={variant}
      onApply={async (next) => {
        const updated = await api.workers.setVisibility(worker.id, next);
        onChange?.(updated);
        return updated.visibility;
      }}
    />
  );
}
