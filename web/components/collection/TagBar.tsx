"use client";

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
  const anyOn = Object.values(active).some((v) => v && v.length > 0);
  const renderedFamilies = TAG_FAMILY_ORDER.filter((f) => (families[f]?.length ?? 0) > 0);
  if (renderedFamilies.length === 0) return null;

  return (
    <div className="c-tagbar" role="group" aria-label="Filters">
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
    </div>
  );
}
