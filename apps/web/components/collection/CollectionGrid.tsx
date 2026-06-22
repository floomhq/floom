"use client";

import { Star } from "lucide-react";
import type { CardSpec } from "@/lib/collection/types";
import { IconButton } from "@/components/ui/icon-button";
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
              <IconButton
                label={spec.star.on ? "Unstar" : "Star"}
                tooltip={null}
                pressed={spec.star.on}
                size="icon-sm"
                // Card-context affordance: absolute top-right, hover-revealed
                // (the `c-gcard:hover .star-btn` rule), accent when starred.
                className={`star-btn absolute top-2.5 right-2.5 ${spec.star.on ? "on" : ""}`}
                onClick={(e) => {
                  e.stopPropagation();
                  spec.star!.onToggle();
                }}
                icon={
                  <Star
                    size={16}
                    fill={spec.star.on ? "currentColor" : "none"}
                  />
                }
              />
            )}
            <div className="c-gtop">
              {spec.leading}
              <div className="c-gnm">{spec.name}</div>
            </div>
            {spec.description != null && <div className="c-gd">{spec.description}</div>}
            {/* B17: muted telemetry line (last-run · run count · success rate) */}
            {spec.meta != null && <div className="c-gmeta">{spec.meta}</div>}
            <div className="c-gfoot">
              {spec.status ? <StatusPill spec={spec.status} /> : null}
              {spec.toolLogos && <div className="c-gtools">{spec.toolLogos}</div>}
              {spec.sparkline && (
                <div className="c-gsparkline">{spec.sparkline}</div>
              )}
            </div>
            {/* B15: hover-revealed quick-action row */}
            {spec.quickActions && spec.quickActions.length > 0 && (
              <div className="c-gactions">
                {spec.quickActions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    className="c-gaction-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      action.onClick(e);
                    }}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
