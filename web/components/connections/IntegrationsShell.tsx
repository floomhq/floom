"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type IntegrationsShellProps = {
  children: ReactNode;
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
};

const PAGE_X = 28;

export function IntegrationsShell({
  children,
  title,
  subtitle,
  actions,
  className,
}: IntegrationsShellProps) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div style={{ padding: `22px ${PAGE_X}px 0` }}>
        {/* Back to the unified Connections list — Connected / MCP / Secrets are
            now TYPE filters on that one surface, so these standalone add/manage
            pages link back to it instead of carrying the old chip section-nav. */}
        <Link
          href="/connections"
          className="mb-3 inline-flex items-center gap-1 text-[13px] text-[var(--ink-soft)] hover:text-ink"
        >
          <ChevronLeft className="size-3.5" aria-hidden="true" />
          Connections
        </Link>
        <div className="c-headrow">
          <div className="c-headtitle">
            <h1 style={{ fontSize: 23, fontWeight: 600, letterSpacing: "-0.02em", margin: 0 }}>
              {title}
            </h1>
            {subtitle && (
              <div style={{ color: "var(--muted-foreground)", marginTop: 2 }}>
                {subtitle}
              </div>
            )}
          </div>
          {actions && <div className="c-counts">{actions}</div>}
        </div>
      </div>
      <div className="c-body" style={{ marginTop: 14 }}>
        <div className="c-listcol" style={{ padding: `0 ${PAGE_X}px 26px` }}>
          <div className="space-y-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
