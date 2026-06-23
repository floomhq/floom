import { describe, expect, it } from "vitest";
import type { ChatMessage, ChatSSEEvent } from "@/lib/emily-chat-types";
import {
  getAutoOpenRunDetailsHref,
  getToolCardTitle,
  isInternalToolName,
  normalizeToolName,
  reduceSSEEvent,
  safeRunPartsStreamPath,
  shouldAutoOpenRunDetails,
} from "@/lib/useChatStream";

function toolCards(messages: ChatMessage[]) {
  return messages.flatMap((message) =>
    (message.parts ?? []).filter((part) => part.type === "tool-card")
  );
}

describe("Emily chat tool cards", () => {
  it("allowlists only run parts SSE stream paths from tool cards", () => {
    expect(safeRunPartsStreamPath("/runs/run_123/stream")).toBe("/runs/run_123/stream");
    expect(safeRunPartsStreamPath(" /runs/run-abc_123/stream ")).toBe("/runs/run-abc_123/stream");
    expect(safeRunPartsStreamPath("/connections")).toBeNull();
    expect(safeRunPartsStreamPath("/runs/run_123/logs/stream")).toBeNull();
    expect(safeRunPartsStreamPath("/runs/run_123/stream?x=/connections")).toBeNull();
    expect(safeRunPartsStreamPath("https://attacker.example/runs/run_123/stream")).toBeNull();
  });

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

  it("keeps generic tool inputs separate from outputs after completion", () => {
    const call: ChatSSEEvent = {
      type: "tool-call",
      callId: "call_context",
      toolName: "contexts__read",
      args: { path: "customer-notes.md" },
      args_preview: { path: "customer-notes.md" },
    };
    const result: ChatSSEEvent = {
      type: "tool-result",
      callId: "call_context",
      toolName: "contexts__read",
      isError: false,
      result: { ok: true, content: "ACME renewal notes" },
    };

    const messages = reduceSSEEvent(reduceSSEEvent([], call, "assistant_1"), result, "assistant_1");
    const completedCard = toolCards(messages)[0]?.card;

    expect(completedCard?.kind).toBe("generic");
    if (completedCard?.kind !== "generic") throw new Error("expected generic card");
    expect(completedCard.args).toEqual({ path: "customer-notes.md" });
    expect(completedCard.result).toEqual({ ok: true, content: "ACME renewal notes" });
  });

  it("normalizes dotted, underscored, and spaced tool names before labeling", () => {
    expect(normalizeToolName("approvals__list_pending")).toBe("approvals.list_pending");
    expect(normalizeToolName("approvals.list pending")).toBe("approvals.list_pending");
    expect(getToolCardTitle("approvals.list pending", "running")).toBe("Checking approvals");
    expect(getToolCardTitle("runs.list", "running")).toBe("Reviewing runs");
    expect(getToolCardTitle("runs.list", "completed")).toBe("Reviewed runs");
    expect(getToolCardTitle("workers__create_from_prompt", "running")).toBe("Creating worker");
    expect(getToolCardTitle("cancel_run POST", "running")).toBe("Cancelling run");
  });

  it("humanizes unknown tools without leaking raw dotted names", () => {
    expect(getToolCardTitle("vendor__fetch_report", "running")).toBe("Fetching report");
    expect(getToolCardTitle("vendor__fetch_report", "completed")).toBe("Fetched report");
    expect(getToolCardTitle("vendor.unknown_slug", "running")).toBe("Unknown slug");
  });

  it("replaces raw progress labels with operator-facing tool labels", () => {
    const call: ChatSSEEvent = {
      type: "tool-call",
      callId: "call_cancel",
      toolName: "cancel_run POST",
      args: {},
    };
    const progress: ChatSSEEvent = {
      type: "tool-progress",
      callId: "call_cancel",
      card_id: "call_cancel",
      status: "running",
      label: "cancel_run POST",
    };

    const messages = reduceSSEEvent(reduceSSEEvent([], call, "assistant_1"), progress, "assistant_1");
    const card = toolCards(messages)[0]?.card;

    expect(card?.kind).toBe("generic");
    if (card?.kind !== "generic") throw new Error("expected generic card");
    expect(card.title).toBe("Cancelling run");
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
    expect(card.toolName).toBe("workers.run");
  });

  it("materializes create-from-prompt results into a progress run card", () => {
    const call: ChatSSEEvent = {
      type: "tool-call",
      callId: "call_create_prompt",
      toolName: "workers__create_from_prompt",
      args: { prompt: "Email me a daily summary" },
      args_preview: { prompt: "Email me a daily summary" },
    };
    const result: ChatSSEEvent = {
      type: "tool-result",
      callId: "call_create_prompt",
      toolName: "workers__create_from_prompt",
      isError: false,
      result: {
        ok: true,
        run_id: "run_author_123",
        worker_id: "worker-author",
        status: "running",
        message: "Worker-author run 'run_author_123' started.",
      },
    };

    const messages = reduceSSEEvent(reduceSSEEvent([], call, "assistant_1"), result, "assistant_1");
    const card = toolCards(messages)[0]?.card;

    expect(card?.kind).toBe("run");
    if (card?.kind !== "run") throw new Error("expected run card");
    expect(card.runId).toBe("run_author_123");
    expect(card.workerName).toBe("Creating worker");
    expect(card.actions?.[0]).toEqual({
      id: "open_run",
      label: "View progress",
      method: "GET",
      href: "/runs?sel=run_author_123&tab=Logs",
    });
  });

  it("marks completed runs.get cards for automatic navigation to run details", () => {
    const call: ChatSSEEvent = {
      type: "tool-call",
      callId: "call_run_details",
      toolName: "runs.get",
      args: { id: "run_123" },
      args_preview: { id: "run_123" },
    };
    const result: ChatSSEEvent = {
      type: "tool-result",
      callId: "call_run_details",
      toolName: "runs.get",
      isError: false,
      result: { ok: true, run_id: "run_123" },
      card: { kind: "run", status: "completed", title: "Opened run details" },
      resource: { kind: "run", run_id: "run_123", worker_id: "research_brief" },
    };

    const messages = reduceSSEEvent(reduceSSEEvent([], call, "assistant_1"), result, "assistant_1");
    const card = toolCards(messages)[0]?.card;

    if (card?.kind !== "run") throw new Error("expected run card");
    expect(card.toolName).toBe("runs.get");
    expect(shouldAutoOpenRunDetails(card)).toBe(true);
    expect(getAutoOpenRunDetailsHref(card)).toBe("/runs?sel=run_123&tab=Logs");
  });

  it("recovers View run from the live nested runs.get result shape", () => {
    const call: ChatSSEEvent = {
      type: "tool-call",
      callId: "call_live_run_details",
      toolName: "runs__get",
      args: { run_id: "run_live_123" },
      args_preview: { run_id: "run_live_123" },
      card: {
        id: "card_call_live_run_details",
        kind: "run",
        title: "runs.get",
        status: "starting",
      },
      actions: [],
    };
    const result: ChatSSEEvent = {
      type: "tool-result",
      callId: "call_live_run_details",
      toolName: "runs__get",
      isError: false,
      result: {
        ok: true,
        run: {
          id: "run_live_123",
          worker_id: "research_brief",
          status: "completed",
        },
      },
      card: {
        id: "card_call_live_run_details",
        kind: "run",
        title: "Opened run details",
        status: "completed",
      },
      actions: [],
    };

    const messages = reduceSSEEvent(reduceSSEEvent([], call, "assistant_1"), result, "assistant_1");
    const card = toolCards(messages)[0]?.card;

    if (card?.kind !== "run") throw new Error("expected run card");
    expect(card.runId).toBe("run_live_123");
    expect(card.workerId).toBe("research_brief");
    expect(card.actions).toEqual([
      {
        id: "open_run",
        label: "View run",
        method: "GET",
        href: "/runs?sel=run_live_123&tab=Logs",
      },
    ]);
    expect(shouldAutoOpenRunDetails(card)).toBe(true);
    expect(getAutoOpenRunDetailsHref(card)).toBe("/runs?sel=run_live_123&tab=Logs");
  });

  it("keeps run auto-open href stable after finish reconciliation", () => {
    const call: ChatSSEEvent = {
      type: "tool-call",
      callId: "call_live_run_details",
      toolName: "runs__get",
      args: { run_id: "run_live_456" },
      args_preview: { run_id: "run_live_456" },
      card: {
        id: "card_call_live_run_details",
        kind: "run",
        title: "runs.get",
        status: "starting",
      },
    };
    const result: ChatSSEEvent = {
      type: "tool-result",
      callId: "call_live_run_details",
      toolName: "runs__get",
      isError: false,
      result: { ok: true, run: { id: "run_live_456", worker_id: "research_brief" } },
      card: {
        id: "card_call_live_run_details",
        kind: "run",
        title: "Opened run details",
        status: "running",
      },
    };
    const finish: ChatSSEEvent = {
      type: "finish",
      conversation_id: "conv_1",
      cards: [
        {
          id: "card_call_live_run_details",
          callId: "call_live_run_details",
          kind: "run",
          status: "completed",
        },
      ],
    };

    const messages = [call, result, finish].reduce(
      (acc, event) => reduceSSEEvent(acc, event, "assistant_1"),
      [] as ChatMessage[]
    );
    const card = toolCards(messages)[0]?.card;

    if (card?.kind !== "run") throw new Error("expected run card");
    expect(card.status).toBe("completed");
    expect(shouldAutoOpenRunDetails(card)).toBe(true);
    expect(getAutoOpenRunDetailsHref(card)).toBe("/runs?sel=run_live_456&tab=Logs");
  });

  it("preserves run stream handles while reconciling worker-run card progress", () => {
    const call: ChatSSEEvent = {
      type: "tool-call",
      callId: "call_worker_run",
      toolName: "workers__run",
      args: { id: "research_brief" },
      args_preview: { id: "research_brief" },
    };
    const result: ChatSSEEvent = {
      type: "tool-result",
      callId: "call_worker_run",
      toolName: "workers__run",
      isError: false,
      result: { ok: true, run_id: "run_stream_1" },
      card: { kind: "run", status: "running" },
      resource: { kind: "run", run_id: "run_stream_1", worker_id: "research_brief" },
      streams: { events: "/runs/run_stream_1/events", parts: "/runs/run_stream_1/stream" },
    };
    const progress: ChatSSEEvent = {
      type: "tool-progress",
      callId: "call_worker_run",
      card_id: "call_worker_run",
      status: "running",
      stage: "executing",
    };

    const messages = [call, result, progress].reduce(
      (acc, event) => reduceSSEEvent(acc, event, "assistant_1"),
      [] as ChatMessage[]
    );
    const card = toolCards(messages)[0]?.card;

    if (card?.kind !== "run") throw new Error("expected run card");
    expect(card.streams?.parts).toBe("/runs/run_stream_1/stream");
    expect(card.status).toBe("running");
    expect(shouldAutoOpenRunDetails(card)).toBe(false);
  });

  it("does not auto-open run cards from worker runs", () => {
    const call: ChatSSEEvent = {
      type: "tool-call",
      callId: "call_worker_run",
      toolName: "workers.run",
      args: { id: "research_brief" },
    };
    const result: ChatSSEEvent = {
      type: "tool-result",
      callId: "call_worker_run",
      toolName: "workers.run",
      isError: false,
      result: { ok: true, run_id: "run_456" },
      card: { kind: "run", status: "running" },
      resource: { kind: "run", run_id: "run_456", worker_id: "research_brief" },
    };

    const messages = reduceSSEEvent(reduceSSEEvent([], call, "assistant_1"), result, "assistant_1");
    const card = toolCards(messages)[0]?.card;

    if (card?.kind !== "run") throw new Error("expected run card");
    expect(shouldAutoOpenRunDetails(card)).toBe(false);
  });
});
