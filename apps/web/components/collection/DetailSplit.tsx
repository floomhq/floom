"use client";

import { useEffect, useRef } from "react";
import { ChevronsLeft, X } from "lucide-react";
import type { DetailHeader, DetailTab } from "@/lib/collection/types";

interface DetailPaneProps {
  header: DetailHeader;
  tabs: DetailTab[];
  activeTab: string;
  onTab: (key: string) => void;
  onClose: () => void;
  onCollapse: () => void;
}

/** The 70% detail pane: header + locked tab row + body (SPEC §3). */
export function DetailPane({
  header,
  tabs,
  activeTab,
  onTab,
  onClose,
  onCollapse,
}: DetailPaneProps) {
  const headerRef = useRef<HTMLDivElement>(null);
  const current = tabs.find((t) => t.key === activeTab) ?? tabs[0];

  // Move focus to the detail header when it opens (SPEC §8c focus rule).
  useEffect(() => {
    headerRef.current?.focus();
  }, []);

  return (
    <>
      <div className="c-dhead" ref={headerRef} tabIndex={-1}>
        <button type="button" className="lcbtn" aria-label="Collapse list" onClick={onCollapse}>
          <ChevronsLeft size={18} />
        </button>
        {header.leading}
        <div className="c-dh-main">
          <div className="c-dh-title">
            <span className="nm">{header.title}</span>
          </div>
          {header.sub != null && <div className="c-dh-sub">{header.sub}</div>}
        </div>
        <div className="c-dh-act" aria-label="Detail actions">
          {header.actions}
          <button type="button" className="x" aria-label="Close detail" onClick={onClose}>
            <X size={16} />
          </button>
        </div>
      </div>
      {/* #1109: skip the tab bar when there is only one tab — it's a redundant
          label that duplicates the section header (e.g. "Developer > Developer"). */}
      {tabs.length > 1 && (
        <div className="c-dtabs" role="tablist">
          {tabs.map((t) => (
            <button
              type="button"
              key={t.key}
              role="tab"
              aria-selected={t.key === current?.key}
              className={`c-dtab ${t.key === current?.key ? "on" : ""}`}
              onClick={() => onTab(t.key)}
            >
              {t.label}
              {t.count != null && <span className="cb">{t.count}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="c-dbody" role="tabpanel">
        {current?.render()}
      </div>
    </>
  );
}
