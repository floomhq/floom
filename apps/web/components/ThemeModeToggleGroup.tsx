"use client";

import { useEffect, useState } from "react";
import { Monitor, Sun, Moon } from "lucide-react";
import { cn } from "@/lib/utils";
import { safeStorageGet, safeStorageSet } from "@/lib/safe-storage";

// S29z: explicit three-button toggle group for /settings#appearance.
// The cycling ThemeModeButton stays in the sidebar (compact). Here we
// surface all three options at once so the user sees what's available.
type ThemeMode = "system" | "day" | "night";

const STORAGE_KEY = "floom-theme";
const SYNC_EVENT = "floom-theme-change";

const OPTIONS: { value: ThemeMode; label: string; icon: typeof Monitor }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "day", label: "Light", icon: Sun },
  { value: "night", label: "Dark", icon: Moon },
];

function readMode(): ThemeMode {
  const stored = safeStorageGet("local", STORAGE_KEY);
  return stored === "day" || stored === "night" || stored === "system" ? stored : "day";
}

function applyMode(mode: ThemeMode) {
  if (typeof window === "undefined") return;
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const isDark = mode === "night" || (mode === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.dataset.theme = mode;
  safeStorageSet("local", STORAGE_KEY, mode);
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { mode } }));
}

export function ThemeModeToggleGroup() {
  const [mode, setMode] = useState<ThemeMode>("day");

  useEffect(() => {
    setMode(readMode());
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent<{ mode: ThemeMode }>).detail;
      if (detail?.mode) setMode(detail.mode);
    };
    window.addEventListener(SYNC_EVENT, onSync);
    return () => window.removeEventListener(SYNC_EVENT, onSync);
  }, []);

  return (
    <div className="inline-flex items-center rounded-lg [border:var(--bd-card)] bg-[var(--bg-card)] p-0.5">
      {OPTIONS.map((opt) => {
        const Icon = opt.icon;
        const active = mode === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => {
              setMode(opt.value);
              applyMode(opt.value);
            }}
            className={cn(
              "inline-flex items-center gap-1.5 px-3 h-8 text-sm transition-colors",
              active
                ? "bg-muted text-foreground font-medium"
                : "text-muted-foreground hover:text-foreground",
            )}
            aria-pressed={active}
          >
            <Icon className="size-3.5" />
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
