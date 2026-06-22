"use client";

import type { ListColumns, ListRowSpec, RowMenuItem } from "@/lib/collection/types";
import { ActionMenu } from "@/components/ui/action-menu";
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
  // Global ⋯ menu (one ActionMenu everywhere) — replaces the hand-rolled
  // open/close state + absolute c-menu div. stopPropagation keeps the row's
  // onClick from firing when the menu trigger is used.
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <ActionMenu
        label="Row actions"
        items={items.map((it) => ({
          label: it.label,
          destructive: it.danger,
          onSelect: it.onSelect,
        }))}
      />
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

  // Shared Collection column-header row (Workers/Brain/Connections all show it).
  // Kept here so it can be reused by both the flat and the grouped (day-section)
  // variants — the grouped list is a variant WITHIN the shared grammar, not a
  // bespoke layout, so it must carry the same header chrome (#1225).
  const head =
    !compact && columns.headers.length > 0 ? (
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
    ) : null;

  // Day/section grouping for the resting list (hidden in compact via CSS).
  // The column header is shared with the flat list so Runs reads with the same
  // grammar as the other Collection pages; the day labels are an in-list option.
  if (group && !compact) {
    const groups = new Map<string, React.ReactNode[]>();
    items.forEach((item, i) => {
      const key = group(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(rows[i]);
    });
    const dayGroups = Array.from(groups.entries()).map(([label, groupRows]) => (
      <div className="c-daygrp" key={label}>
        <div className="dh">{label}</div>
        <div className="c-ltable">{groupRows}</div>
      </div>
    ));
    return (
      <div className="c-grouped">
        {head}
        {dayGroups}
      </div>
    );
  }

  return (
    <div className="c-ltable">
      {head}
      {rows}
    </div>
  );
}
