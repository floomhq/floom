"use client";

import { useEffect, useState } from "react";

type ThemeMode = "system" | "day" | "night";

const STORAGE_KEY = "floom-theme";
const ORDER: ThemeMode[] = ["system", "day", "night"];
const LABELS: Record<ThemeMode, string> = {
  system: "System",
  day: "Light",
  night: "Dark",
};

function readMode(): ThemeMode {
  if (typeof window === "undefined") return "day";
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === "day" || stored === "night" || stored === "system" ? stored : "day";
}

function applyMode(mode: ThemeMode) {
  if (typeof window === "undefined") return;
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  const isDark = mode === "night" || (mode === "system" && prefersDark);
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.dataset.theme = mode;
  window.localStorage.setItem(STORAGE_KEY, mode);
}

export function ThemeModeButton({ className = "" }: { className?: string }) {
  const [mode, setMode] = useState<ThemeMode>("day");

  useEffect(() => {
    const initial = readMode();
    setMode(initial);
    applyMode(initial);

    const media = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!media) return undefined;

    const onChange = () => {
      if (readMode() === "system") applyMode("system");
    };

    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
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
      <span>{LABELS[mode]}</span>
    </button>
  );
}
