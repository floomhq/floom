"use client";

import { Star } from "lucide-react";
import type { CardSpec } from "@/lib/collection/types";
import { StatusPill } from "./StatusPill";

interface CollectionGridProps<T> {
  items: T[];
  idOf: (item: T) => string;
  card: (item: T) => CardSpec;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function CollectionGrid<T>({
  items,
  idOf,
  card,
  selectedId,
  onSelect,
}: CollectionGridProps<T>) {
  return (
    <div className="c-grid">
      {items.map((item) => {
        const id = idOf(item);
        const spec = card(item);
        return (
          <div
            role="button"
            tabIndex={0}
            data-collrow
            key={id}
            aria-current={id === selectedId ? "true" : undefined}
            className={`c-gcard ${id === selectedId ? "sel" : ""}`}
            onClick={() => onSelect(id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                onSelect(id);
              }
            }}
          >
            {spec.star && (
              <button
                type="button"
                aria-label="Toggle star"
                aria-pressed={spec.star.on}
                className={`star ${spec.star.on ? "on" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  spec.star!.onToggle();
                }}
              >
                <Star size={16} fill={spec.star.on ? "currentColor" : "none"} />
              </button>
            )}
            <div className="c-gtop">
              {spec.leading}
              <div className="c-gnm">{spec.name}</div>
            </div>
            {spec.description != null && <div className="c-gd">{spec.description}</div>}
            <div className="c-gfoot">
              {spec.status ? <StatusPill spec={spec.status} /> : null}
              {spec.toolLogos && <div className="c-gtools">{spec.toolLogos}</div>}
              {spec.sparkline && (
                <div className="c-gsparkline">{spec.sparkline}</div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
