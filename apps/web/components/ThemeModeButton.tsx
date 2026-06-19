"use client";

import { useEffect, useState } from "react";
import { safeStorageGet, safeStorageSet } from "@/lib/safe-storage";

type ThemeMode = "system" | "day" | "night";

const STORAGE_KEY = "floom-theme";
const SYNC_EVENT = "floom-theme-change";
const ORDER: ThemeMode[] = ["system", "day", "night"];
const LABELS: Record<ThemeMode, string> = {
  system: "System",
  day: "Light",
  night: "Dark",
};

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
  // PR S19 (I-43): broadcast so every mounted ThemeModeButton (e.g. the
  // sidebar one AND the one inside Settings → Appearance) re-syncs.
  window.dispatchEvent(new CustomEvent(SYNC_EVENT, { detail: { mode } }));
}

export function ThemeModeButton({ className = "" }: { className?: string }) {
  const [mode, setMode] = useState<ThemeMode>("day");

  useEffect(() => {
    const initial = readMode();
    setMode(initial);
    applyMode(initial);

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onMedia = () => {
      if (readMode() === "system") applyMode("system");
    };
    media?.addEventListener("change", onMedia);

    // PR S19 (I-43): listen for sibling instances toggling the theme so
    // this button's local state stays consistent with the actual mode.
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent<{ mode: ThemeMode }>).detail;
      if (detail?.mode) setMode(detail.mode);
    };
    window.addEventListener(SYNC_EVENT, onSync);

    return () => {
      media?.removeEventListener("change", onMedia);
      window.removeEventListener(SYNC_EVENT, onSync);
    };
  }, []);

  function cycle() {
    const next = ORDER[(ORDER.indexOf(mode) + 1) % ORDER.length];
    setMode(next);
    applyMode(next);
  }

  return (
    <button
      type="button"
      className={`theme-mode-button ${className}`.trim()}
      onClick={cycle}
      aria-label={`Theme mode: ${LABELS[mode]}. Click to switch.`}
      title={`Theme: ${LABELS[mode]}`}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        {mode === "night" ? (
          <path d="M21 14.5A8.5 8.5 0 0 1 9.5 3a7 7 0 1 0 11.5 11.5Z" />
        ) : mode === "day" ? (
          <>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
          </>
        ) : (
          <>
            <circle cx="12" cy="12" r="8" />
            <path d="M12 4v16M4 12h16" />
          </>
        )}
      </svg>
    </button>
  );
}
