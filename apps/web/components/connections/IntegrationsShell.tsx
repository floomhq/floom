"use client";

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import { ConnectionsChips } from "@/components/connections/ConnectionsChips";

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
      <div style={{ padding: `10px ${PAGE_X}px 0` }}>
        <ConnectionsChips />
      </div>
      <div className="c-body" style={{ marginTop: 14 }}>
        <div className="c-listcol" style={{ padding: `0 ${PAGE_X}px 26px` }}>
          <div className="space-y-6">{children}</div>
        </div>
      </div>
    </div>
  );
}
