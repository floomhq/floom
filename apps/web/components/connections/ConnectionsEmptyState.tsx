import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BrandLogo } from "./BrandLogo";

export function ConnectionsEmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="rounded-[var(--radius-ui)] bg-[var(--glass-bg)] px-5 py-10 text-center">
      <div className="mx-auto flex size-11 items-center justify-center rounded-[var(--radius-ui)] bg-[var(--paper)]">
        <BrandLogo icon="gmail" className="size-5" />
      </div>
      <p className="mx-auto mt-4 max-w-md text-sm font-medium text-[var(--ink)]">
        Connect a tool to give your workers access to Gmail, Calendar, Slack, and 200+ more.
      </p>
      <Button type="button" size="sm" className="mt-5" onClick={onConnect}>
        <Plus className="size-3.5" />
        Connect Gmail
      </Button>
    </div>
  );
}
