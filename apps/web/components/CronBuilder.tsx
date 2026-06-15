"use client";

/**
 * CronBuilder — visual cron scheduler.
 *
 * Produces a standard 5-field cron expression and a human-readable preview.
 * Presets: every-minute, hourly, daily, weekly, monthly, custom.
 * Custom mode reveals a raw input for power users.
 */

import { useState, useEffect } from "react";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

// ---------------------------------------------------------------------------
// Cron string builder helpers
// ---------------------------------------------------------------------------

type Frequency = "minute" | "hourly" | "daily" | "weekday" | "weekly" | "monthly" | "custom";

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const MINUTES = Array.from({ length: 60 }, (_, i) => i);
const DOM = Array.from({ length: 28 }, (_, i) => i + 1); // 1-28 (safe across all months)

const DOW_LABELS: [string, string][] = [
  ["1", "Mon"],
  ["2", "Tue"],
  ["3", "Wed"],
  ["4", "Thu"],
  ["5", "Fri"],
  ["6", "Sat"],
  ["0", "Sun"],
];

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function buildCron(
  freq: Frequency,
  hour: number,
  minute: number,
  dow: string[],
  dom: number,
): string {
  const h = hour;
  const m = minute;
  switch (freq) {
    case "minute":
      return "* * * * *";
    case "hourly":
      return `${m} * * * *`;
    case "daily":
      return `${m} ${h} * * *`;
    case "weekday":
      return `${m} ${h} * * 1-5`;
    case "weekly": {
      const days = dow.length > 0 ? dow.sort().join(",") : "1";
      return `${m} ${h} * * ${days}`;
    }
    case "monthly":
      return `${m} ${h} ${dom} * *`;
    case "custom":
      return "";
  }
}

// ---------------------------------------------------------------------------
// Human-readable preview (no external dep, covers common patterns)
// ---------------------------------------------------------------------------

function describeFreq(freq: Frequency, hour: number, minute: number, dow: string[], dom: number): string {
  const timeStr = `${pad2(hour)}:${pad2(minute)}`;
  switch (freq) {
    case "minute":
      return "Every minute";
    case "hourly":
      return `Every hour at :${pad2(minute)}`;
    case "daily":
      return `Daily at ${timeStr}`;
    case "weekday":
      return `Every weekday (Mon-Fri) at ${timeStr}`;
    case "weekly": {
      if (dow.length === 0) return `Weekly at ${timeStr}`;
      const names = dow.sort().map((d) => DOW_LABELS.find(([v]) => v === d)?.[1] ?? d);
      return `Every ${names.join(", ")} at ${timeStr}`;
    }
    case "monthly":
      return `Monthly on day ${dom} at ${timeStr}`;
    case "custom":
      return "";
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface CronBuilderProps {
  /** Current cron expression (controlled) */
  value: string;
  /** Called with the new cron expression whenever it changes */
  onChange: (cron: string) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function CronBuilder({ value, onChange }: CronBuilderProps) {
  const [freq, setFreq] = useState<Frequency>("daily");
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [dow, setDow] = useState<string[]>(["1"]); // Mon by default for weekly
  const [dom, setDom] = useState(1);
  const [customExpr, setCustomExpr] = useState(value || "0 9 * * *");

  // On first mount: try to detect the frequency from the incoming value so
  // we pre-select the right preset instead of always defaulting to "daily".
  useEffect(() => {
    if (!value) return;
    const parts = value.trim().split(/\s+/);
    if (parts.length !== 5) { setFreq("custom"); setCustomExpr(value); return; }
    const [m, h, dayOfMonth, month, dayOfWeek] = parts;
    if (m === "*" && h === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      setFreq("minute"); return;
    }
    if (h === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      setFreq("hourly"); setMinute(parseInt(m) || 0); return;
    }
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "1-5") {
      setFreq("weekday"); setHour(parseInt(h) || 9); setMinute(parseInt(m) || 0); return;
    }
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
      setFreq("daily"); setHour(parseInt(h) || 9); setMinute(parseInt(m) || 0); return;
    }
    if (dayOfMonth === "*" && month === "*" && dayOfWeek !== "*") {
      setFreq("weekly");
      setHour(parseInt(h) || 9); setMinute(parseInt(m) || 0);
      setDow(dayOfWeek.split(",").map((d) => d.trim()));
      return;
    }
    if (dayOfMonth !== "*" && month === "*" && dayOfWeek === "*") {
      setFreq("monthly");
      setHour(parseInt(h) || 9); setMinute(parseInt(m) || 0);
      setDom(parseInt(dayOfMonth) || 1);
      return;
    }
    setFreq("custom"); setCustomExpr(value);
  // Only run on initial mount to avoid circular updates
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Emit cron whenever any visual field changes
  useEffect(() => {
    if (freq === "custom") return;
    const expr = buildCron(freq, hour, minute, dow, dom);
    if (expr && expr !== value) onChange(expr);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [freq, hour, minute, dow, dom]);

  function handleFreqChange(f: Frequency) {
    setFreq(f);
    if (f !== "custom") {
      const expr = buildCron(f, hour, minute, dow, dom);
      if (expr) onChange(expr);
    } else {
      onChange(customExpr);
    }
  }

  function handleCustomChange(expr: string) {
    setCustomExpr(expr);
    onChange(expr);
  }

  function toggleDow(day: string) {
    const next = dow.includes(day) ? dow.filter((d) => d !== day) : [...dow, day];
    const safe = next.length === 0 ? [day] : next; // keep at least one day
    setDow(safe);
  }

  const preview = freq !== "custom"
    ? describeFreq(freq, hour, minute, dow, dom)
    : "";

  const showTimePicker = freq !== "minute" && freq !== "custom";
  const showDow = freq === "weekly";
  const showDom = freq === "monthly";

  return (
    <div className="space-y-3">
      {/* Frequency */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground ">Frequency</Label>
        <div className="flex flex-wrap gap-1.5">
          {([
            ["minute", "Every minute"],
            ["hourly", "Hourly"],
            ["daily", "Daily"],
            ["weekday", "Weekdays"],
            ["weekly", "Weekly"],
            ["monthly", "Monthly"],
          ] as [Frequency, string][]).map(([f, label]) => (
            <button
              key={f}
              type="button"
              onClick={() => handleFreqChange(f)}
              className={`h-7 rounded-[var(--radius-ui)] px-2.5 text-xs font-medium transition-colors ${
                freq === f
                  ? "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]"
                  : " bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Time picker (hour + minute) */}
      {showTimePicker && (
        <div className="flex items-end gap-2">
          <div className="space-y-1.5 flex-1">
            <Label className="text-xs text-muted-foreground">Hour</Label>
            <Select value={String(hour)} onValueChange={(v) => setHour(parseInt(v ?? "0"))}>
              <SelectTrigger className=" h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-52">
                {HOURS.map((h) => (
                  <SelectItem key={h} value={String(h)} className="text-xs">
                    {pad2(h)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5 flex-1">
            <Label className="text-xs text-muted-foreground">Minute</Label>
            <Select value={String(minute)} onValueChange={(v) => setMinute(parseInt(v ?? "0"))}>
              <SelectTrigger className=" h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className="max-h-52">
                {MINUTES.map((m) => (
                  <SelectItem key={m} value={String(m)} className="text-xs">
                    {pad2(m)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      )}

      {/* Day-of-week multi-select (weekly) */}
      {showDow && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Days of week</Label>
          <div className="flex flex-wrap gap-1.5">
            {DOW_LABELS.map(([v, label]) => (
              <button
                key={v}
                type="button"
                onClick={() => toggleDow(v)}
                className={`h-7 w-10 rounded-[var(--radius-ui)] text-xs font-medium transition-colors ${
                  dow.includes(v)
                    ? "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]"
                    : " bg-card text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Day-of-month (monthly) */}
      {showDom && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Day of month</Label>
          <Select value={String(dom)} onValueChange={(v) => setDom(parseInt(v ?? "1"))}>
            <SelectTrigger className=" h-8 text-xs w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-52">
              {DOM.map((d) => (
                <SelectItem key={d} value={String(d)} className="text-xs">
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Human preview */}
      {preview && (
        <p className="text-xs text-muted-foreground bg-muted rounded-[var(--radius-ui)] px-3 py-2 font-medium">
          {preview}
        </p>
      )}

      {/* Custom cron toggle */}
      <div className="pt-1">
        <button
          type="button"
          onClick={() => handleFreqChange(freq === "custom" ? "daily" : "custom")}
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-muted-foreground transition-colors"
        >
          {freq === "custom" ? "Back to visual picker" : "Use custom cron expression"}
        </button>
      </div>

      {/* Custom raw input */}
      {freq === "custom" && (
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Cron expression</Label>
          <Input
            value={customExpr}
            onChange={(e) => handleCustomChange(e.target.value)}
            className=" font-mono text-sm"
            placeholder="0 9 * * *"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">5-field standard cron: minute hour day-of-month month day-of-week</p>
        </div>
      )}
    </div>
  );
}
