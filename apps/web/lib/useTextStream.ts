"use client";

/**
 * useTextStream — smooth typewriter animation for streaming text.
 *
 * When `streaming` is true the hook reveals the target text incrementally
 * (~12 chars per 16ms tick ≈ 60fps) so tokens render smoothly instead of chunky.
 * When `streaming` flips to false it immediately snaps to the full target text.
 *
 * Returns the currently-displayed string. Pass it to any text renderer.
 */

import { useEffect, useRef, useState } from "react";

const CHARS_PER_TICK = 12; // characters revealed per animation frame
const TICK_MS = 16; // ~60 fps

export function useTextStream(
  target: string,
  streaming: boolean,
  mode: "typewriter" | "fade" = "typewriter"
): string {
  const [displayed, setDisplayed] = useState(target);
  // posRef tracks how many characters of `target` we've already revealed.
  const posRef = useRef(target.length);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep a ref to the latest target so the tick closure never captures a stale one.
  const targetRef = useRef(target);

  useEffect(() => {
    // Update the ref at the start of the effect so the tick closure always
    // reads the current target without capturing a stale closure value.
    targetRef.current = target;

    // Cancel any running timer first.
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }

    if (!streaming || mode === "fade") {
      // Snap to full text immediately.
      setDisplayed(target);
      posRef.current = target.length;
      return;
    }

    // Typewriter mode: animate chars up to target.length.
    if (posRef.current >= target.length) {
      // Already caught up — just sync displayed.
      setDisplayed(target);
      return;
    }

    function tick() {
      const newPos = Math.min(posRef.current + CHARS_PER_TICK, target.length);
      posRef.current = newPos;
      setDisplayed(target.slice(0, newPos));
      if (newPos < target.length) {
        timerRef.current = setTimeout(tick, TICK_MS);
      } else {
        timerRef.current = null;
      }
    }

    timerRef.current = setTimeout(tick, TICK_MS);

    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [target, streaming, mode]);

  return displayed;
}
