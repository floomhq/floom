"use client";

import type { TimeseriesDay } from "@/lib/types";

interface SparklineProps {
  data: TimeseriesDay[];
  width?: number;
  height?: number;
}

/**
 * Tiny SVG bar chart for run history over N days.
 * Green bars = completed runs, red bars = failed runs.
 * Stacked: green on bottom, red on top.
 */
export function Sparkline({ data, width = 120, height = 32 }: SparklineProps) {
  if (!data || data.length === 0) return null;

  const maxTotal = Math.max(...data.map((d) => d.total), 1);
  const barW = Math.floor((width - 2) / data.length) - 1;
  const gap = 1;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ display: "block" }}
    >
      {data.map((day, i) => {
        const x = i * (barW + gap);
        const totalH = day.total > 0 ? Math.max(2, Math.round((day.total / maxTotal) * (height - 2))) : 0;
        const failedFrac = day.total > 0 ? day.failed / day.total : 0;
        const failedH = Math.round(totalH * failedFrac);
        const completedH = totalH - failedH;
        const y = height - totalH;

        const title = `${day.date}: ${day.completed} ok, ${day.failed} failed`;

        return (
          <g key={day.date}>
            <title>{title}</title>
            {/* Green (completed) bar at bottom of the stack */}
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
            {/* Red (failed) bar stacked on top */}
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
            {/* Empty day: faint bar */}
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
