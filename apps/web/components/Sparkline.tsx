"use client";

import { useEffect, useState } from "react";

import type { TimeseriesDay } from "@/lib/types";
import type { OverviewSparklineBucket } from "@/lib/types";

interface SparklineProps {
  data: TimeseriesDay[] | OverviewSparklineBucket[] | number[];
  width?: number;
  height?: number;
  className?: string;
  tone?: "status" | "overview";
  /**
   * Full-width area+line variant for metric cards. Renders a single accent
   * line with a subtle gradient fill beneath, stretched edge-to-edge via
   * width="100%" + preserveAspectRatio="none". Ignores the bar rendering.
   */
  variant?: "bars" | "area";
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
export function Sparkline({
  data,
  width = 120,
  height = 32,
  className,
  tone = "status",
  variant = "bars",
}: SparklineProps) {
  // Hovered bucket index for the area-variant tooltip (-1 = none). Declared
  // before the early return so hook order stays stable across variants.
  const [hovered, setHovered] = useState(-1);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!data || data.length === 0) return null;

  const isStructured = typeof data[0] === "object" && data[0] !== null;
  const counts = isStructured
    ? (data as Array<TimeseriesDay | OverviewSparklineBucket>).map((d) => d.total)
    : (data as number[]);

  const maxTotal = Math.max(...counts, 1);

  // Full-width area+line variant — a single accent line with a low-opacity
  // gradient fill, stretched edge-to-edge. preserveAspectRatio="none" lets the
  // fixed viewBox scale to whatever width="100%" resolves to in the card.
  if (variant === "area") {
    const fillId = `spark-fill-${counts.length}-${maxTotal}`;
    const stepX = counts.length > 1 ? width / (counts.length - 1) : width;
    const yFor = (v: number) => {
      const h = Math.max(0, Math.round((v / maxTotal) * (height - 2)));
      return height - 1 - h;
    };
    const points = counts.map((v, i) => `${(i * stepX).toFixed(2)},${yFor(v).toFixed(2)}`);
    const linePath = `M ${points.join(" L ")}`;
    const areaPath = `${linePath} L ${width},${height} L 0,${height} Z`;

    // Per-bucket label/value for the hover tooltip. OverviewSparklineBucket
    // carries a human label (e.g. weekday) we surface; the raw number[] form
    // falls back to a bucket index.
    const buckets = isStructured
      ? (data as Array<TimeseriesDay | OverviewSparklineBucket>)
      : null;
    const bucketLabel = (i: number) => {
      const b = buckets?.[i];
      if (!b) return null;
      if ("label" in b && b.label) return b.label;
      if ("date" in b && b.date) return b.date;
      return null;
    };

    const active = hovered >= 0 && hovered < counts.length ? hovered : -1;
    const activeValue = active >= 0 ? counts[active] : 0;
    const activeLabel = active >= 0 ? bucketLabel(active) : null;
    // Tooltip x as a percentage so it tracks the bucket under the scaled SVG.
    const tooltipLeft = active >= 0 && counts.length > 1
      ? (active / (counts.length - 1)) * 100
      : 0;

    return (
      <div className={`relative ${className ?? ""}`}>
        <svg
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{ display: "block" }}
          className="h-full w-full"
        >
          <defs>
            <linearGradient id={fillId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.18" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d={areaPath} fill={`url(#${fillId})`} stroke="none" />
          <path
            d={linePath}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* Active-point marker */}
          {active >= 0 ? (
            <circle
              cx={active * stepX}
              cy={yFor(counts[active])}
              r={2.5}
              fill="var(--accent)"
              vectorEffect="non-scaling-stroke"
            />
          ) : null}
          {/* Invisible per-bucket hover regions. They carry a native <title>
              as an accessible fallback and drive the positioned tooltip. */}
          {counts.map((v, i) => {
            const label = bucketLabel(i);
            const title = `${label ? `${label} · ` : ""}${v} ${v === 1 ? "run" : "runs"}`;
            return (
              <rect
                key={i}
                x={i === 0 ? 0 : (i - 0.5) * stepX}
                y={0}
                width={i === 0 || i === counts.length - 1 ? stepX / 2 : stepX}
                height={height}
                fill="transparent"
                onMouseEnter={() => setHovered(i)}
                onMouseLeave={() => setHovered((h) => (h === i ? -1 : h))}
              >
                {mounted ? <title>{title}</title> : null}
              </rect>
            );
          })}
        </svg>
        {active >= 0 ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute bottom-full z-10 mb-1 whitespace-nowrap rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--popover)] px-2 py-1 text-[11px] leading-tight text-[var(--popover-foreground)] shadow-[var(--shadow-pop)]"
            style={{
              left: `${tooltipLeft}%`,
              // Keep edge tooltips from overflowing the card.
              transform:
                tooltipLeft <= 8
                  ? "translateX(0)"
                  : tooltipLeft >= 92
                    ? "translateX(-100%)"
                    : "translateX(-50%)",
            }}
          >
            <span className="font-medium text-[var(--text-primary)]">{activeValue}</span>{" "}
            <span className="text-[var(--text-muted)]">{activeValue === 1 ? "run" : "runs"}</span>
            {activeLabel ? (
              <span className="ml-1 text-[var(--text-muted)]">· {activeLabel}</span>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  const barW = Math.max(1, Math.floor((width - 2) / data.length) - 1);
  const gap = 1;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      style={{ display: "block" }}
      className={className}
    >
      {data.map((entry, i) => {
        const x = i * (barW + gap);
        const total = isStructured
          ? (entry as TimeseriesDay | OverviewSparklineBucket).total
          : (entry as number);
        const totalH =
          total > 0 ? Math.max(2, Math.round((total / maxTotal) * (height - 2))) : 0;

        if (tone === "overview" && isStructured) {
          const bucket = entry as OverviewSparklineBucket;
          const failed = bucket.failed ?? 0;
          const title = `${bucket.label} · ${total} ${total === 1 ? "run" : "runs"} · ${failed} failed`;
          return (
            <rect
              key={bucket.started_at ?? i}
              x={x}
              y={totalH === 0 ? height - 2 : height - totalH}
              width={barW}
              height={totalH === 0 ? 2 : totalH}
              fill="var(--text-primary)"
              opacity={failed > 0 ? 1 : totalH === 0 ? 0.16 : 0.3}
              rx={1}
            >
              {mounted ? <title>{title}</title> : null}
            </rect>
          );
        }

        if (!isStructured) {
          if (totalH === 0) {
            return (
              <rect
                key={i}
                x={x}
                y={height - 2}
                width={barW}
                height={2}
                fill="var(--border-soft)"
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
              fill="var(--success)"
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
            {mounted ? <title>{title}</title> : null}
            {completedH > 0 && (
              <rect
                x={x}
                y={height - completedH}
                width={barW}
                height={completedH}
                fill="var(--success)"
                rx={1}
              />
            )}
            {failedH > 0 && (
              <rect
                x={x}
                y={height - totalH}
                width={barW}
                height={failedH}
                fill="var(--warning)"
                rx={1}
              />
            )}
            {totalH === 0 && (
              <rect
                x={x}
                y={height - 2}
                width={barW}
                height={2}
                fill="var(--border-soft)"
                rx={1}
              />
            )}
          </g>
        );
      })}
    </svg>
  );
}
