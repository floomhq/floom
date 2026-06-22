"use client";

/**
 * /templates/admin — moderation queue. Lists pending community submissions and
 * lets a moderator approve/reject. The backend gates this to
 * MARKETPLACE_ADMIN_USER_IDS; non-moderators get an honest 403 state.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { V3Shell } from "../../V3Shell";
import "../../theme.css";

type Submission = {
  id: string;
  item_kind: string;
  title: string;
  summary: string;
  category: string;
  tools_json: string[];
  created_at: string;
};

export function V3AdminBody() {
  const [subs, setSubs] = useState<Submission[]>([]);
  const [state, setState] = useState<"loading" | "ok" | "forbidden" | "error">("loading");

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/marketplace/submissions?status=pending", { cache: "no-store" });
      if (res.status === 401 || res.status === 403) return setState("forbidden");
      if (!res.ok) return setState("error");
      const data = await res.json();
      setSubs(Array.isArray(data.submissions) ? data.submissions : []);
      setState("ok");
    } catch {
      setState("error");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function moderate(id: string, status: "approved" | "rejected") {
    await fetch(`/api/marketplace/submissions/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    setSubs((s) => s.filter((x) => x.id !== id));
  }

  return (
    <V3Shell active="templates">
      <Link href="/templates" className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> All templates
      </Link>

      <div className="pb-24 pt-10">
        <h1 className="text-[30px] font-semibold tracking-[-0.028em]">Moderation queue</h1>
        <p className="mt-2 text-[14px] text-muted-foreground">Community submissions awaiting review.</p>

        {state === "loading" && <p className="mt-8 text-[13.5px] text-muted-foreground">Loading…</p>}
        {state === "forbidden" && (
          <p className="mt-8 text-[13.5px] text-muted-foreground">You don&apos;t have moderator access.</p>
        )}
        {state === "error" && (
          <p className="mt-8 text-[13.5px] text-muted-foreground">Couldn&apos;t load the queue.</p>
        )}
        {state === "ok" && subs.length === 0 && (
          <p className="mt-8 text-[13.5px] text-muted-foreground">Queue is clear — nothing pending.</p>
        )}

        {state === "ok" && subs.length > 0 && (
          <div className="mt-8 space-y-3">
            {subs.map((s) => (
              <div key={s.id} className="rounded-[14px] bg-card p-5">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="text-[10.5px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
                      {s.category} · {s.item_kind}
                    </div>
                    <h3 className="mt-1 text-[16px] font-semibold">{s.title}</h3>
                    <p className="mt-1 text-[13px] text-muted-foreground">{s.summary}</p>
                    {s.tools_json?.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {s.tools_json.map((t) => (
                          <span key={t} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">{t}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button
                      onClick={() => moderate(s.id, "approved")}
                      className="rounded-[10px] px-3 py-1.5 text-[12.5px] font-medium text-white"
                      style={{ background: "var(--v3-accent)" }}
                    >
                      Approve
                    </button>
                    <button
                      onClick={() => moderate(s.id, "rejected")}
                      className="rounded-[10px] bg-secondary px-3 py-1.5 text-[12.5px] text-foreground/80"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </V3Shell>
  );
}
