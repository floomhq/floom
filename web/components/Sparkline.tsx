"use client";

import type { TimeseriesDay } from "@/lib/types";

interface SparklineProps {
  data: TimeseriesDay[] | number[];
  width?: number;
  height?: number;
}

/**
 * Tiny SVG bar chart.
 *
 * Accepts either:
 *  - TimeseriesDay[] (per-bucket {date,total,completed,failed}) — green/red stacked
 *  - number[] (raw counts per bucket) — single colour, no failed split
 *
 * The number[] form is used when failed-counts aren't surfaced by the source
 * (e.g. /system/overview 24-hour hourly buckets). When/if the API gains
 * failed-counts there, callers can switch to TimeseriesDay[] without changing
 * this component.
 */
export function Sparkline({ data, width = 120, height = 32 }: SparklineProps) {
  if (!data || data.length === 0) return null;

  const isStructured = typeof data[0] === "object" && data[0] !== null;
  const counts = isStructured
    ? (data as TimeseriesDay[]).map((d) => d.total)
    : (data as number[]);

  const maxTotal = Math.max(...counts, 1);
  const barW = Math.max(1, Math.floor((width - 2) / data.length) - 1);
  const gap = 1;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {data.map((entry, i) => {
        const x = i * (barW + gap);
        const total = isStructured
          ? (entry as TimeseriesDay).total
          : (entry as number);
        const totalH =
          total > 0 ? Math.max(2, Math.round((total / maxTotal) * (height - 2))) : 0;

        if (!isStructured) {
          if (totalH === 0) {
            return (
              <rect
                key={i}
                x={x}
                y={height - 2}
                width={barW}
                height={2}
                fill="#e4e4e7"
                rx={1}
              />
            );
          }
          return (
            <rect
              key={i}
              x={x}
              y={height - totalH}
              width={barW}
              height={totalH}
              fill="#22c55e"
              rx={1}
            />
          );
        }

        const day = entry as TimeseriesDay;
        const failedFrac = day.total > 0 ? day.failed / day.total : 0;
        const failedH = Math.round(totalH * failedFrac);
        const completedH = totalH - failedH;
        const title = `${day.date}: ${day.completed} ok, ${day.failed} failed`;

        return (
          <g key={day.date ?? i}>
            <title>{title}</title>
            {completedH > 0 && (
              <rect
                x={x}
                y={height - completedH}
                width={barW}
                height={completedH}
                fill="#22c55e"
                rx={1}
              />
            )}
            {failedH > 0 && (
              <rect
                x={x}
                y={height - totalH}
                width={barW}
                height={failedH}
                fill="#ef4444"
                rx={1}
              />
            )}
            {totalH === 0 && (
              <rect
                x={x}
                y={height - 2}
                width={barW}
                height={2}
                fill="#e4e4e7"
                rx={1}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
