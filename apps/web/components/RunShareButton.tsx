"use client";

import { useState } from "react";
import { api } from "@/lib/api";
import { ShareModal } from "@/components/sharing/ShareModal";

// #765: share a run via the Drive-pattern modal (no visibility level — runs are
// owner-scoped; just a public view-only link that can be revoked).
export function RunShareButton({ runId, label = "Share" }: { runId: string; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="c-vpill"
        style={{ padding: "6px 11px" }}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(true);
        }}
      >
        {label}
      </button>
      <ShareModal
        open={open}
        onOpenChange={setOpen}
        title="run"
        getShareLink={async () => (await api.runs.shareLink(runId)).url}
        onRevokeShareLink={async () => {
          await api.runs.revokeShareLink(runId);
        }}
      />
    </>
  );
}
