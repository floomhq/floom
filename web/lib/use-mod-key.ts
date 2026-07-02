import { useEffect, useState } from "react";

/**
 * The platform modifier shown in keyboard-shortcut hints: "⌘" on macOS, "Ctrl"
 * everywhere else (Windows / Linux). Showing the Mac ⌘ glyph to a Windows user
 * is meaningless, so the hint follows the actual platform.
 *
 * SSR-safe: returns "⌘" until the client detects the platform (one frame after
 * hydration) so there is no hydration mismatch. This only changes the DISPLAY —
 * the command-palette handler already accepts `metaKey || ctrlKey`, so Ctrl+K
 * already works on Windows.
 */
export function useModKey(): string {
  const [mod, setMod] = useState("⌘");
  useEffect(() => {
    const ua =
      typeof navigator !== "undefined"
        ? `${navigator.platform || ""} ${navigator.userAgent || ""}`
        : "";
    setMod(/Mac|iPhone|iPad|iPod/i.test(ua) ? "⌘" : "Ctrl");
  }, []);
  return mod;
}
