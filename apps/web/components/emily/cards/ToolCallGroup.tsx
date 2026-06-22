"use client";

import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ToolCard } from "@/lib/emily-chat-types";
import { cn } from "@/lib/utils";
import { ToolCardRenderer } from "./ToolCardRenderer";

// A single Emily run can fire a long sequence of tool calls (e.g. "Create a
// Stripe alert worker" → ~14 worker-author / runs.get / files writes). Rendering
// each as its own collapsible row produced an unreadable wall of repeated
// "worker-author / completed / Open in app" cards with raw Args/Result JSON.
//
// This groups a consecutive run of tool-call cards into ONE summary line
// ("▸ N tool calls", with "· M failed" when any failed) that is collapsed by
// default. Expanding reveals the individual cards (each still its own
// collapsible with Args/Result hidden until that card is opened). The noisy
// intermediate spam collapses; failures are always surfaced in the summary so a
// failed call is never silently hidden inside the count.

function isFailedCard(card: ToolCard): boolean {
  return card.status === "failed" || card.status === "error" || card.status === "cancelled";
}

export function ToolCallGroup({
  cards,
  defaultOpen = false,
}: {
  cards: ToolCard[];
  /** When the group still has an in-flight call, the host opens it so progress
   *  stays visible while Emily works. */
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const failed = cards.filter(isFailedCard).length;
  const label = `${cards.length} tool ${cards.length === 1 ? "call" : "calls"}`;

  return (
    <div className="space-y-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="group flex w-full items-center gap-1.5 rounded-[var(--radius-button)] px-1 py-1 text-left text-xs text-muted-foreground hover:text-foreground transition-colors"
      >
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/60 transition-transform duration-150",
            open && "rotate-90",
          )}
        />
        <span className="font-medium">{label}</span>
        {failed > 0 && (
          <span className="text-destructive">
            · {failed} failed
          </span>
        )}
      </button>
      {open && (
        <div className="space-y-2 pl-1">
          {cards.map((card) => (
            <ToolCardRenderer key={card.card_id} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}
