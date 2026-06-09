import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatSSEEvent } from "@/lib/emily-chat-types";
import {
  getToolCardTitle,
  isInternalToolName,
  normalizeToolName,
  reduceSSEEvent,
} from "@/lib/useChatStream";

function toolCards(messages: ChatMessage[]) {
  return messages.flatMap((message) =>
    (message.parts ?? []).filter((part) => part.type === "tool-card")
  );
}

describe("Emily chat tool cards", () => {
  it("hides internal finalization tools from the card stream", () => {
    const messages = reduceSSEEvent(
      [],
      {
        type: "tool-call",
        callId: "call_finish",
        toolName: "finish_with_outputs",
        args: { reply: "Done" },
      },
      "assistant_1"
    );

    expect(toolCards(messages)).toHaveLength(0);
    expect(isInternalToolName("finish with outputs")).toBe(true);
    expect(isInternalToolName("finish")).toBe(true);
  });

  it("uses outcome-native labels and updates them when the tool completes", () => {
    const call: ChatSSEEvent = {
      type: "tool-call",
      callId: "call_workers",
      toolName: "workers__list_all",
      args: {},
    };
    const result: ChatSSEEvent = {
      type: "tool-result",
      callId: "call_workers",
      isError: false,
      result: { ok: true },
    };

    const runningMessages = reduceSSEEvent([], call, "assistant_1");
    const runningCard = toolCards(runningMessages)[0]?.card;
    expect(runningCard?.kind).toBe("generic");
    if (runningCard?.kind !== "generic") throw new Error("expected generic card");
    expect(runningCard?.title).toBe("Listing your workers");

    const completedMessages = reduceSSEEvent(runningMessages, result, "assistant_1");
    const completedCard = toolCards(completedMessages)[0]?.card;
    if (completedCard?.kind !== "generic") throw new Error("expected generic card");
    expect(completedCard?.status).toBe("completed");
    expect(completedCard?.title).toBe("Listed your workers");
  });

  it("normalizes dotted, underscored, and spaced tool names before labeling", () => {
    expect(normalizeToolName("approvals__list_pending")).toBe("approvals.list_pending");
    expect(normalizeToolName("approvals.list pending")).toBe("approvals.list_pending");
    expect(getToolCardTitle("approvals.list pending", "running")).toBe("Checking approvals");
    expect(getToolCardTitle("runs.list", "running")).toBe("Reviewing runs");
    expect(getToolCardTitle("runs.list", "completed")).toBe("Reviewed runs");
  });

  it("humanizes unknown tools without leaking raw dotted names", () => {
    expect(getToolCardTitle("vendor__fetch_report", "running")).toBe("Fetching report");
    expect(getToolCardTitle("vendor__fetch_report", "completed")).toBe("Fetched report");
    expect(getToolCardTitle("vendor.unknown_slug", "running")).toBe("Unknown slug");
  });

  it("surfaces SSE error events as assistant text", () => {
    const messages = reduceSSEEvent(
      [{ id: "u-1", role: "user", text: "What workers do I have?" }],
      {
        type: "error",
        error: "Worker list failed",
      },
      "assistant_1"
    );

    const assistant = messages.find((message) => message.id === "assistant_1");
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.parts).toEqual([
      { type: "text", text: "Worker list failed", streaming: false },
    ]);
  });

  it("materializes worker list tool results into a worker-list card", () => {
    const call: ChatSSEEvent = {
      type: "tool-call",
      callId: "call_workers",
      toolName: "workers__list_all",
      args: {},
    };
    const result: ChatSSEEvent = {
      type: "tool-result",
      callId: "call_workers",
      toolName: "workers__list_all",
      isError: false,
      result: {
        ok: true,
        workers: [
          { id: "research_brief", title: "Research Brief", trigger: "manual", enabled: true },
          { id: "weekly_update", name: "Weekly Update", trigger: "schedule", enabled: false },
        ],
      },
      card: { kind: "worker-list", status: "completed" },
    };

    const messages = reduceSSEEvent(reduceSSEEvent([], call, "assistant_1"), result, "assistant_1");
    const card = toolCards(messages)[0]?.card;

    expect(card?.kind).toBe("worker-list");
    if (card?.kind !== "worker-list") throw new Error("expected worker-list card");
    expect(card.status).toBe("completed");
    expect(card.workers).toEqual([
      { id: "research_brief", name: "Research Brief", trigger: "manual", enabled: true },
      { id: "weekly_update", name: "Weekly Update", trigger: "schedule", enabled: false },
    ]);
  });

  it("materializes worker run tool results into a run card", () => {
    const call: ChatSSEEvent = {
      type: "tool-call",
      callId: "call_run",
      toolName: "workers__run",
      args: { id: "research_brief" },
      args_preview: { id: "research_brief" },
    };
    const result: ChatSSEEvent = {
      type: "tool-result",
      callId: "call_run",
      toolName: "workers__run",
      isError: false,
      result: { ok: true, run_id: "run_123" },
      card: { kind: "run", status: "running" },
      resource: { kind: "run", run_id: "run_123", worker_id: "research_brief" },
      streams: { events: "/runs/run_123/events", parts: "/runs/run_123/stream" },
      actions: [{ id: "open_run", method: "GET", href: "/runs/run_123" }],
    };

    const messages = reduceSSEEvent(reduceSSEEvent([], call, "assistant_1"), result, "assistant_1");
    const card = toolCards(messages)[0]?.card;

    expect(card?.kind).toBe("run");
    if (card?.kind !== "run") throw new Error("expected run card");
    expect(card.status).toBe("running");
    expect(card.runId).toBe("run_123");
    expect(card.workerId).toBe("research_brief");
    expect(card.workerName).toBe("research_brief");
    expect(card.streams?.parts).toBe("/runs/run_123/stream");
  });
});
