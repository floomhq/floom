/**
 * #842 — rehydration must reconstruct the interactive WorkerListCard.
 *
 * RCA: rehydrateConversation always called toGenericCard, ignoring the
 * persisted result_preview — after navigating away and back (or refreshing),
 * the interactive worker list became a static "Listed your workers" card.
 *
 * Fix: worker-list rows (by persisted card.kind or normalized tool name) are
 * rebuilt from result_preview via workerRowsFromResult — the same mapper the
 * live SSE path uses — and only fall back to GenericToolCard when no usable
 * preview was persisted.
 *
 * Run: cd apps/web && npx vitest run tests/emily-chat-rehydrate-worker-list.test.ts
 */
import { describe, expect, it } from "vitest";
import { rehydrateConversation } from "@/lib/emily-chat-rehydrate";
import type { ConversationDetail } from "@/lib/types";
import type { MsgPart, WorkerListCard } from "@/lib/emily-chat-types";

function cardParts(detail: ConversationDetail) {
  const parts: MsgPart[] = rehydrateConversation(detail)
    .flatMap((m) => (m.role === "assistant" ? m.parts ?? [] : []));
  return parts.filter((p) => p.type === "tool-card");
}

const baseDetail = (toolCard: Record<string, unknown>): ConversationDetail =>
  ({
    id: "conv-1",
    messages: [
      { id: "m1", role: "user", content: "what workers do I have?", created_at: "2026-06-10T10:00:00Z" },
      { id: "m2", role: "assistant", content: "Here are your workers.", created_at: "2026-06-10T10:00:02Z" },
    ],
    tool_cards: [toolCard],
  } as unknown as ConversationDetail);

describe("rehydrateConversation worker-list reconstruction (#842)", () => {
  it("rebuilds a WorkerListCard from the persisted result_preview", () => {
    const detail = baseDetail({
      id: "tc1",
      callId: "call-1",
      toolName: "workers__list_all",
      status: "completed",
      created_at: "2026-06-10T10:00:01Z",
      result_preview: {
        ok: true,
        workers: [
          { id: "w1", title: "Daily digest", name: "daily-digest", trigger: "cron", enabled: true },
          { id: "w2", name: "scraper", enabled: false },
        ],
      },
    });

    const cards = cardParts(detail);
    expect(cards).toHaveLength(1);
    const card = (cards[0] as Extract<MsgPart, { type: "tool-card" }>).card;
    expect(card.kind).toBe("worker-list");
    const wl = card as WorkerListCard;
    expect(wl.workers).toEqual([
      { id: "w1", name: "Daily digest", trigger: "cron", enabled: true },
      { id: "w2", name: "scraper", enabled: false },
    ]);
    expect(wl.callId).toBe("call-1");
  });

  it("recognises worker-list rows by persisted card.kind", () => {
    const detail = baseDetail({
      id: "tc2",
      callId: "call-2",
      toolName: "some_alias",
      status: "completed",
      created_at: "2026-06-10T10:00:01Z",
      card: { kind: "worker-list" },
      result_preview: { workers: [{ id: "w9", name: "n9" }] },
    });

    const card = (cardParts(detail)[0] as Extract<MsgPart, { type: "tool-card" }>).card;
    expect(card.kind).toBe("worker-list");
  });

  it("falls back to GenericToolCard when no result_preview was persisted", () => {
    const detail = baseDetail({
      id: "tc3",
      callId: "call-3",
      toolName: "workers__list_all",
      status: "completed",
      created_at: "2026-06-10T10:00:01Z",
      result_preview: null,
    });

    const card = (cardParts(detail)[0] as Extract<MsgPart, { type: "tool-card" }>).card;
    expect(card.kind).toBe("generic");
  });

  it("rebuilds a RunCard from persisted run_id and result_preview", () => {
    const detail = baseDetail({
      id: "tc5",
      callId: "call-5",
      toolName: "workers__run",
      status: "completed",
      created_at: "2026-06-10T10:00:01Z",
      run_id: "run-77",
      worker_id: "w-3",
      result_preview: { run_id: "run-77", run: { worker_name: "Daily digest" } },
    });

    const card = (cardParts(detail)[0] as Extract<MsgPart, { type: "tool-card" }>).card;
    expect(card.kind).toBe("run");
    const run = card as import("@/lib/emily-chat-types").RunCard;
    expect(run.runId).toBe("run-77");
    expect(run.workerId).toBe("w-3");
    expect(run.workerName).toBe("Daily digest");
    expect(run.actions?.[0]?.href).toBe("/runs/run-77?tab=logs");
  });

  it("run-shaped rows without any run id fall back to GenericToolCard", () => {
    const detail = baseDetail({
      id: "tc6",
      callId: "call-6",
      toolName: "runs__get",
      status: "completed",
      created_at: "2026-06-10T10:00:01Z",
      result_preview: null,
    });

    const card = (cardParts(detail)[0] as Extract<MsgPart, { type: "tool-card" }>).card;
    expect(card.kind).toBe("generic");
  });

  it("leaves unrelated tools as GenericToolCard", () => {
    const detail = baseDetail({
      id: "tc4",
      callId: "call-4",
      toolName: "contexts__read",
      status: "completed",
      created_at: "2026-06-10T10:00:01Z",
      result_preview: { workers: [{ id: "w1", name: "n" }] },
    });

    const card = (cardParts(detail)[0] as Extract<MsgPart, { type: "tool-card" }>).card;
    expect(card.kind).toBe("generic");
  });
});
