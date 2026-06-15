"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Search, LayoutGrid, List as ListIcon, Plus, ChevronsRight, X } from "lucide-react";
import {
  type CollectionConfig,
  type CollectionState,
  type TagFamilyKey,
  type ViewMode,
} from "@/lib/collection/types";
import { filterItems } from "@/lib/collection/filter";
import { TagBar } from "./TagBar";
import { CollectionList } from "./CollectionList";
import { CollectionGrid } from "./CollectionGrid";
import { DetailPane } from "./DetailSplit";
import { EmptyState, LoadingState, ErrorState } from "./CollectionStates";

export interface CollectionViewProps<T> {
  config: CollectionConfig<T>;
  state: CollectionState;
  onChange: (next: CollectionState) => void;
  /** Called when ?sel points at a missing item (drives a toast + resting). */
  onInvalidSel?: (id: string) => void;
}

const PAGE_X = 28;

export function CollectionView<T>({ config, state, onChange, onInvalidSel }: CollectionViewProps<T>) {
  const [listCollapsed, setListCollapsed] = useState(false);
  const [creating, setCreating] = useState(false); // +Add opens in the detail pane
  const gridEnabled = config.view?.grid ?? false;

  const filtered = useMemo(
    () => filterItems(config.items, state, { searchOf: config.searchOf, tagsOf: config.tagsOf }),
    [config.items, config.searchOf, config.tagsOf, state],
  );

  const selected = useMemo(() => {
    if (!state.sel) return null;
    const found = config.items.find((i) => config.idOf(i) === state.sel) ?? null;
    return found;
  }, [config, state.sel]);

  // Invalid ?sel → resting + toast (SPEC §3, §8b). Side effect, not in render.
  const selMissing = state.sel != null && selected == null && !config.loading;
  useEffect(() => {
    if (selMissing && state.sel) onInvalidSel?.(state.sel);
  }, [selMissing, state.sel, onInvalidSel]);

  const patch = useCallback(
    (p: Partial<CollectionState>) => onChange({ ...state, ...p }),
    [onChange, state],
  );

  const setView = (view: ViewMode) => {
    patch({ view });
  };
  const setQuery = (q: string) => {
    patch({ q });
  };
  const open = (id: string) => {
    setListCollapsed(false);
    setCreating(false);
    patch({ sel: id, tab: null });
  };
  const close = () => {
    setListCollapsed(false);
    setCreating(false);
    patch({ sel: null, tab: null });
  };
  const toggleTagValue = (family: TagFamilyKey, value: string) => {
    const cur = state.tags[family] ?? [];
    const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
    const tags = { ...state.tags };
    if (next.length) tags[family] = next;
    else delete tags[family];
    patch({ tags });
  };
  const clearTags = () => {
    patch({ tags: {} });
  };

  const isOpen = selected != null;

  // ---- detail (split right pane) ----
  const detail = isOpen ? config.detail(selected!) : null;
  const activeTabKey =
    detail && state.tab && detail.tabs.some((t) => t.key === state.tab)
      ? state.tab!
      : detail?.tabs[0]?.key ?? "";

  // ---- keyboard nav (SPEC §8c) ----
  const onKeyDown = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement | null;
    const dialogOpen =
      target?.closest?.('[role="dialog"], [data-slot="dialog-content"]') ||
      document.querySelector('[role="dialog"], [data-slot="dialog-content"]');
    if (e.key === "Escape" && dialogOpen) return;
    if (e.key === "Escape" && isOpen) {
      close();
      return;
    }
    if (e.key === "[" && isOpen) {
      setListCollapsed((v) => !v);
      return;
    }
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && filtered.length) {
      const down = e.key === "ArrowDown";
      if (isOpen) {
        // Split mode: arrows change the open selection.
        e.preventDefault();
        const ids = filtered.map(config.idOf);
        const idx = state.sel ? ids.indexOf(state.sel) : -1;
        const nextIdx = down ? Math.min(ids.length - 1, idx + 1) : Math.max(0, idx <= 0 ? 0 : idx - 1);
        patch({ sel: ids[nextIdx], tab: null });
      } else {
        // Resting list: roving DOM focus across rows/cards; Enter (handled by the
        // row itself) opens the focused item (SPEC §8c).
        const rows = Array.from(
          bodyRef.current?.querySelectorAll<HTMLElement>("[data-collrow]") ?? [],
        );
        if (!rows.length) return;
        e.preventDefault();
        const cur = rows.indexOf(document.activeElement as HTMLElement);
        const nextIdx = down ? Math.min(rows.length - 1, cur + 1) : Math.max(0, cur <= 0 ? 0 : cur - 1);
        rows[cur < 0 ? 0 : nextIdx]?.focus();
      }
    }
  };
  const bodyRef = useRef<HTMLDivElement>(null);

  const header = (
    <div style={{ padding: `22px ${PAGE_X}px 0` }}>
      <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
        <div>
          <div style={{ fontSize: 23, fontWeight: 600, letterSpacing: "-0.02em" }}>
            {config.title}
          </div>
          {config.subtitle && (
            <div style={{ color: "var(--muted-foreground)", marginTop: 2 }}>{config.subtitle}</div>
          )}
        </div>
        {config.counts && config.counts.length > 0 && (
          <div className="c-counts" style={{ marginLeft: "auto" }}>
            {config.counts.map((c, i) => (
              <span className="ct" key={i}>
                <b>{c.value}</b> {c.label}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  const viewToggle = gridEnabled && !isOpen && (
    <div className="c-vtog" role="group" aria-label="View mode">
      <button
        type="button"
        aria-label="Grid view"
        aria-pressed={state.view === "grid"}
        className={state.view === "grid" ? "on" : ""}
        onClick={() => setView("grid")}
      >
        <LayoutGrid size={15} />
      </button>
      <button
        type="button"
        aria-label="List view"
        aria-pressed={state.view === "list"}
        className={state.view === "list" ? "on" : ""}
        onClick={() => setView("list")}
      >
        <ListIcon size={15} />
      </button>
    </div>
  );

  const searchBox = (compact?: boolean) => (
    <div className="c-srch" style={compact ? { maxWidth: "none", padding: "8px 11px" } : undefined}>
      <Search size={compact ? 14 : 15} />
      <input
        type="search"
        aria-label="Search"
        placeholder={config.searchPlaceholder ?? `Search ${config.title.toLowerCase()}…`}
        value={state.q}
        onChange={(e) => setQuery(e.target.value)}
      />
    </div>
  );

  const addButton = config.add && (
    <button
      type="button"
      className="c-addbtn"
      onClick={() => {
        if (config.add!.panel) {
          patch({ sel: null, tab: null });
          setListCollapsed(false);
          setCreating(true);
        } else {
          config.add!.onSelect?.();
        }
      }}
    >
      <Plus size={14} /> {config.add.label}
    </button>
  );

  // ---- body content (list / grid / states) ----
  const listOrGrid = (compact: boolean) => {
    if (config.loading) return <LoadingState />;
    if (config.error) return <ErrorState message={config.error} onRetry={config.states?.errorRetry} />;
    if (filtered.length === 0) {
      return (
        <EmptyState
          title={config.states?.empty?.title ?? `No ${config.title.toLowerCase()} yet`}
          help={config.states?.empty?.help}
          icon={config.states?.empty?.icon}
          action={addButton}
        />
      );
    }
    const showGrid = !compact && !isOpen && gridEnabled && state.view === "grid";
    if (showGrid && config.card) {
      return (
        <CollectionGrid
          items={filtered}
          idOf={config.idOf}
          card={config.card}
          selectedId={state.sel}
          onSelect={open}
        />
      );
    }
    return (
      <CollectionList
        items={filtered}
        columns={config.columns}
        idOf={config.idOf}
        row={config.row}
        group={config.group}
        selectedId={state.sel}
        onSelect={open}
        compact={compact}
      />
    );
  };

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}
      onKeyDown={onKeyDown}
    >
      {header}

      {!isOpen && !creating && (
        <>
          <div className="c-toolbar" style={{ padding: `14px ${PAGE_X}px 0` }}>
            {searchBox()}
            {viewToggle}
            <div style={{ marginLeft: "auto", display: "flex", gap: 10, alignItems: "center" }}>
              {config.toolbarActions}
              {addButton}
            </div>
          </div>
          {config.tags && (
            <div className="c-tagbar-wrap" style={{ padding: `12px ${PAGE_X}px 2px` }}>
              <TagBar
                families={config.tags}
                active={state.tags}
                onToggle={toggleTagValue}
                onClear={clearTags}
              />
            </div>
          )}
          <div className="c-body" style={{ marginTop: 14 }}>
            <div className="c-listcol" ref={bodyRef} style={{ padding: `0 ${PAGE_X}px 26px` }}>
              {config.banner}
              {listOrGrid(false)}
            </div>
          </div>
        </>
      )}

      {((isOpen && detail) || creating) && (
        <div className={`c-body c-split ${listCollapsed ? "lc" : ""}`} style={{ marginTop: 14 }}>
          <div className="c-listcol">
            <div className="c-sliver">
              <button
                type="button"
                aria-label="Expand list"
                onClick={() => setListCollapsed(false)}
                style={{ color: "var(--muted-foreground)" }}
              >
                <ChevronsRight size={16} />
              </button>
            </div>
            <div className="c-splitbar">{searchBox(true)}</div>
            <div className="lcin">
              {config.banner}
              {listOrGrid(true)}
            </div>
          </div>
          <div className="c-detailcol">
            {creating && config.add?.panel ? (
              <>
                <div className="c-dhead">
                  <div className="c-dh-main">
                    <div className="c-dh-title">
                      <span className="nm">{config.add.panel.title}</span>
                    </div>
                  </div>
                  <div className="c-dh-act">
                    <button type="button" className="x" aria-label="Close detail" onClick={close}>
                      <X size={16} />
                    </button>
                  </div>
                </div>
                <div className="c-dbody">{config.add.panel.render(close)}</div>
              </>
            ) : (
              detail && (
                <DetailPane
                  header={detail.header}
                  tabs={detail.tabs}
                  activeTab={activeTabKey}
                  onTab={(key) => patch({ tab: key })}
                  onClose={close}
                  onCollapse={() => setListCollapsed((v) => !v)}
                />
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
