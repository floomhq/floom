"use client";

// S45: overview page — AlertsBell in top-right, OverviewDashboard below.
import { useCallback, useRef, useState } from "react";
import { AlertsBell } from "@/components/overview/AlertsBell";
import { OverviewDashboard } from "@/components/overview/OverviewDashboard";
import type { SystemOverviewAttentionItem } from "@/components/overview/OverviewDashboard";

export default function OverviewPage() {
  const [attentionItems, setAttentionItems] = useState<SystemOverviewAttentionItem[]>([]);
  // reloadRef holds the dashboard reload callback so the bell can trigger a refresh
  const reloadRef = useRef<(() => void) | null>(null);

  const handleAttentionItems = useCallback((items: SystemOverviewAttentionItem[]) => {
    setAttentionItems(items);
  }, []);

  const handleRefresh = useCallback(() => {
    reloadRef.current?.();
  }, []);

  return (
    <div className="relative flex flex-1 flex-col">
      {/* Bell anchored top-right of the content pane */}
      <div className="absolute right-0 top-1 z-10">
        <AlertsBell items={attentionItems} onRefresh={handleRefresh} />
      </div>
      <OverviewDashboard
        onAttentionItems={handleAttentionItems}
        onReloadRef={reloadRef}
      />
    </div>
  );
}
