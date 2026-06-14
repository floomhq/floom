"use client";

import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import type { ListColumns, ListRowSpec, RowMenuItem } from "@/lib/collection/types";
import { StatusPill } from "./StatusPill";

interface CollectionListProps<T> {
  items: T[];
  columns: ListColumns;
  idOf: (item: T) => string;
  row: (item: T) => ListRowSpec;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Optional day/section grouping (Runs groups by day — SPEC §5). */
  group?: (item: T) => string;
  /** Compact = split-left list (single column; CSS hides cols/pill/menu). */
  compact?: boolean;
}

function RowMenu({ items }: { items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="c-menu" style={{ position: "relative" }}>
      <button
        type="button"
        aria-label="Row actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <MoreHorizontal size={18} />
      </button>
      {open && (
        <div
          role="menu"
          onMouseLeave={() => setOpen(false)}
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            zIndex: 30,
            minWidth: 168,
            background: "var(--bg-card)",
            borderRadius: "var(--radius-ui)",
            boxShadow: "var(--shadow-pop)",
            padding: 5,
          }}
        >
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                it.onSelect();
              }}
              style={{
                display: "block",
                width: "100%",
                textAlign: "left",
                padding: "8px 10px",
                borderRadius: "var(--radius-ui)",
                fontSize: 13,
                color: it.danger ? "var(--warning)" : "var(--ink-soft)",
              }}
            >
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Row<T>({
  item,
  spec,
  template,
  selected,
  onSelect,
  compact,
}: {
  item: T;
  spec: ListRowSpec;
  template: string;
  selected: boolean;
  onSelect: () => void;
  compact?: boolean;
}) {
  void item;
  const showStatus = template.includes("__status__");
  const showMenu = template.includes("__menu__");
  const gridTemplate = template.replace("__status__", "").replace("__menu__", "").trim();
  return (
    <div
      role="button"
      tabIndex={0}
      data-collrow
      aria-current={selected ? "true" : undefined}
      className={`c-lrow ${selected ? "sel" : ""}`}
      style={compact ? undefined : { gridTemplateColumns: gridTemplate }}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <div className="c-lprimary">
        {spec.leading}
        <div className="c-lp-tx">
          <div className="nm">{spec.primary}</div>
          {spec.secondary != null && <div className="sub">{spec.secondary}</div>}
        </div>
      </div>
      {(spec.cols ?? []).map((c, i) => (
        <div className="c-cell" key={i}>
          {c}
        </div>
      ))}
      {showStatus && <div>{spec.status ? <StatusPill spec={spec.status} /> : null}</div>}
      {showMenu && <div className="c-menu">{spec.menu?.length ? <RowMenu items={spec.menu} /> : null}</div>}
    </div>
  );
}

export function CollectionList<T>({
  items,
  columns,
  idOf,
  row,
  selectedId,
  onSelect,
  group,
  compact,
}: CollectionListProps<T>) {
  const template = `${columns.template} ${columns.statusColumn === false ? "" : "__status__"} ${columns.menuColumn === false ? "" : "__menu__"}`;
  const rows = items.map((item) => {
    const id = idOf(item);
    return (
      <Row
        key={id}
        item={item}
        spec={row(item)}
        template={template}
        selected={id === selectedId}
        onSelect={() => onSelect(id)}
        compact={compact}
      />
    );
  });

  // Day/section grouping for the resting list (hidden in compact via CSS).
  let body: React.ReactNode = rows;
  if (group && !compact) {
    const groups = new Map<string, React.ReactNode[]>();
    items.forEach((item, i) => {
      const key = group(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(rows[i]);
    });
    body = Array.from(groups.entries()).map(([label, groupRows]) => (
      <div className="c-daygrp" key={label}>
        <div className="dh">{label}</div>
        <div className="c-ltable">{groupRows}</div>
      </div>
    ));
    return <div>{body}</div>;
  }

  return (
    <div className="c-ltable">
      {!compact && columns.headers.length > 0 && (
        <div
          className="c-lhead"
          style={{
            gridTemplateColumns: columns.template,
            ...(columns.headerTransparent ? { background: "transparent" } : {}),
          }}
        >
          {columns.headers.map((h, i) => (
            <div key={i}>{h}</div>
          ))}
        </div>
      )}
      {body}
    </div>
  );
}
