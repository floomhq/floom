"use client";

import { Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export type ClaimChannel = "whatsapp" | "slack";

interface ClaimSuccessOverlayProps {
  channel: ClaimChannel;
  /** Primary action: continue into the app (e.g. go to dashboard / close). */
  onContinue: () => void;
}

const COPY: Record<ClaimChannel, { title: string; line: string }> = {
  whatsapp: {
    title: "You're connected",
    line: "Emily will message you on WhatsApp. Tell her what you want handled.",
  },
  slack: {
    title: "You're connected",
    line: "Emily is ready in Slack. DM her what you want handled.",
  },
};

/**
 * Full-screen success confirmation shown after a channel claim is consumed.
 *
 * Federico feedback 2026-06-11: a successful link should feel like a real
 * milestone (full-screen), not a small inline toast. Warm matte, Geist,
 * ChatGPT-simplicity bar: one accent (success/sage), real iconography, no
 * gradients or colored-left-borders, no emoji-as-icon.
 */
export function ClaimSuccessOverlay({ channel, onContinue }: ClaimSuccessOverlayProps) {
  const copy = COPY[channel];
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Channel linked"
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-background px-6 text-center"
    >
      <div className="flex w-full max-w-sm flex-col items-center">
        <div
          className="flex size-16 items-center justify-center rounded-full"
          style={{
            backgroundColor: "color-mix(in srgb, var(--success) 12%, var(--background))",
          }}
        >
          <Check className="size-8" style={{ color: "var(--success)" }} aria-hidden />
        </div>

        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-foreground">
          {copy.title}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.line}</p>

        <Button className="mt-8 w-full" onClick={onContinue} autoFocus>
          Go to dashboard
        </Button>
      </div>
    </div>
  );
}
