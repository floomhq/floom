"use client";

/**
 * V3CommunityStrip — renders APPROVED community submissions beneath the
 * first-party catalog, so the publish→review→live loop is visibly complete.
 * Renders nothing until there are approved items (graceful empty).
 */

import { useEffect, useState } from "react";

type CommunityItem = {
  id: string;
  slug: string | null;
  title: string;
  summary: string;
  category: string;
  tools_json: string[];
};

export function V3CommunityStrip({ kind }: { kind: "worker" | "workspace" }) {
  const [items, setItems] = useState<CommunityItem[]>([]);

  useEffect(() => {
    let live = true;
    fetch(`/api/marketplace/community?item_kind=${kind}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (live) setItems(Array.isArray(d.items) ? d.items : []);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [kind]);

  if (items.length === 0) return null;

  return (
    <div className="mt-14">
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-[17px] font-semibold tracking-[-0.018em]">From the community</h2>
        <span className="text-[12.5px] text-muted-foreground">Reviewed &amp; approved by Floom</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((it) => (
          <div key={it.id} className="flex h-full flex-col overflow-hidden rounded-[16px] bg-card">
            <div className="px-5 pb-4 pt-5">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10.5px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
                  {it.category}
                </div>
                <span
                  className="rounded-full px-2 py-0.5 text-[9.5px] font-medium"
                  style={{ background: "var(--v3-sel)", color: "var(--v3-accent)" }}
                >
                  Community
                </span>
              </div>
              <h3 className="mt-2 text-[16px] font-semibold leading-snug tracking-[-0.02em]">{it.title}</h3>
              <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">{it.summary}</p>
            </div>
            {it.tools_json?.length > 0 && (
              <div className="mt-auto flex flex-wrap gap-1.5 px-5 py-3">
                {it.tools_json.slice(0, 4).map((t) => (
                  <span key={t} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
