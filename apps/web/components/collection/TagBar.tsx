"use client";

import { useState } from "react";
import { Filter } from "lucide-react";
import {
  type TagFamilies,
  type TagFamilyKey,
  type CollectionState,
  TAG_FAMILY_ORDER,
} from "@/lib/collection/types";

interface TagBarProps {
  families: TagFamilies;
  active: CollectionState["tags"];
  onToggle: (family: TagFamilyKey, value: string) => void;
  onClear: () => void;
}

/**
 * The ONLY filter primitive (SPEC §1). One bar, chips left→right by family,
 * all multi-select, default = all selected. An "all" chip deselects everything.
 */
export function TagBar({ families, active, onToggle, onClear }: TagBarProps) {
  const [open, setOpen] = useState(false);
  const anyOn = Object.values(active).some((v) => v && v.length > 0);
  const activeCount = Object.values(active).reduce((sum, v) => sum + (v?.length ?? 0), 0);
  const renderedFamilies = TAG_FAMILY_ORDER.filter((f) => (families[f]?.length ?? 0) > 0);
  if (renderedFamilies.length === 0) return null;

  // #1709: unified to "Add filter" (singular) for both visible label and aria-label
  return (
    <div className="c-filterbar" role="group" aria-label="Add filter">
      <button
        type="button"
        className={`c-tag c-filter-toggle ${open || anyOn ? "on" : ""}`}
        aria-expanded={open}
        aria-label="Add filter"
        onClick={() => setOpen((value) => !value)}
      >
        <Filter className="size-3" aria-hidden="true" />
        Add filter
        {activeCount > 0 && <span className="ct">{activeCount}</span>}
      </button>
      {open && (
        <div className="c-tagbar">
          <div className="c-tgroup">
            <button
              type="button"
              className={`c-tag ${anyOn ? "" : "on"}`}
              aria-pressed={!anyOn}
              onClick={onClear}
            >
              all
            </button>
          </div>
          {renderedFamilies.map((family) => (
            <div className="c-tgroup" key={family} data-family={family}>
              {families[family]!.map((opt) => {
                const on = (active[family] ?? []).includes(opt.value);
                return (
                  <button
                    type="button"
                    key={opt.value}
                    className={`c-tag ${on ? "on" : ""}`}
                    aria-pressed={on}
                    onClick={() => onToggle(family, opt.value)}
                  >
                    {opt.label.toLowerCase()}
                    {opt.count != null && <span className="ct">{opt.count}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {anyOn && (
            <div className="c-tgroup">
              <button type="button" className="c-tag" onClick={onClear}>
                clear
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
