import { TriangleAlert } from "lucide-react";

export function DryRunNotice() {
  return (
    <div
      role="status"
      aria-label="Dry run"
      className="flex items-start gap-3 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] px-4 py-3 text-[var(--ink)] shadow-[inset_4px_0_0_var(--warning)]"
    >
      <TriangleAlert className="mt-0.5 size-5 shrink-0 text-[var(--warning)]" aria-hidden="true" />
      <p className="text-sm font-medium">
        <strong>Dry run:</strong> no external actions taken, no drafts created.
      </p>
    </div>
  );
}
