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
    expect(runningCard?.title).toBe("Listing your workers");

    const completedMessages = reduceSSEEvent(runningMessages, result, "assistant_1");
    const completedCard = toolCards(completedMessages)[0]?.card;
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
});
