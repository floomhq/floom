"use client";

/**
 * Emily chat — rehydration.
 *
 * Maps the persisted server conversation (GET /conversations/{id}, see
 * apps/api/main.py:get_conversation_detail) into the live ChatMessage[] shape
 * that useChatStream builds from the SSE stream, so a reloaded/reopened
 * conversation renders identically to a freshly streamed one.
 *
 * Server shape:
 *   messages:   [{ id, role: "user"|"assistant"|"tool", content, tool_call_id, created_at }]
 *   tool_cards: [{ id, callId, toolName, status, card, ... , created_at }]
 *
 * Strategy: build one chronological timeline keyed by created_at.
 *   - user message     → ChatMessage { role: "user", text }
 *   - assistant message→ ChatMessage { role: "assistant", parts: [text] }
 *   - tool card        → tool-card part appended to the current assistant turn
 *                        (a new assistant turn is opened if none is active)
 *   - "tool" role messages are raw tool results already represented by their
 *     card, so they are skipped for rendering.
 */

import type {
  ConversationDetail,
  ConversationMessageRow,
  ConversationToolCardRow,
} from "./types";
import type {
  ChatMessage,
  GenericToolCard,
  MsgPart,
  CardStatus,
  RunCard,
  ToolCard,
  WorkerListCard,
} from "./emily-chat-types";
import {
  asRecord,
  getToolCardTitle,
  isInternalToolName,
  normalizeToolName,
  optionalString,
  workerRowsFromResult,
} from "./useChatStream";

type TimelineItem =
  | { kind: "message"; ts: string; row: ConversationMessageRow }
  | { kind: "card"; ts: string; row: ConversationToolCardRow };

function normalizeStatus(raw: unknown): CardStatus {
  const s = typeof raw === "string" ? raw : "";
  return (s || "completed") as CardStatus;
}

function toGenericCard(row: ConversationToolCardRow): GenericToolCard {
  const toolName = row.toolName || "tool";
  const status = normalizeStatus(row.status);
  const callId = row.callId || row.id;
  return {
    kind: "generic",
    callId,
    card_id: row.id || callId,
    toolName,
    title: getToolCardTitle(toolName, status),
    preview:
      (row.args_preview as Record<string, unknown> | undefined) ?? undefined,
    status,
    ...(row.streams ? { streams: row.streams } : {}),
    ...(row.actions && row.actions.length
      ? { actions: row.actions as GenericToolCard["actions"] }
      : {}),
  };
}

/**
 * #842 RCA: rehydration always produced a static GenericToolCard ("Listed
 * your workers" + checkmark) and ignored the persisted result_preview, so the
 * interactive WorkerListCard disappeared after navigation/refresh. This
 * rebuilds the specialised card from result_preview using the same row mapper
 * the live SSE path uses.
 */
function toWorkerListCard(row: ConversationToolCardRow): WorkerListCard | null {
  const normalized = row.toolName ? normalizeToolName(row.toolName) : "";
  const persistedKind = (row.card as { kind?: unknown } | null)?.kind;
  if (persistedKind !== "worker-list" && normalized !== "workers.list_all") {
    return null;
  }
  const workers = workerRowsFromResult(row.result_preview);
  if (!workers) return null;
  const callId = row.callId || row.id;
  return {
    kind: "worker-list",
    callId,
    card_id: row.id || callId,
    status: normalizeStatus(row.status),
    workers,
    ...(row.streams ? { streams: row.streams } : {}),
    ...(row.actions && row.actions.length
      ? { actions: row.actions as WorkerListCard["actions"] }
      : {}),
  };
}

/**
 * #842 (follow-through): rebuild RunCard rows the same way — from the
 * persisted run_id/worker_id columns plus result_preview — mirroring the
 * detection rules of the live runCardFromResult.
 */
function toRunCard(row: ConversationToolCardRow): RunCard | null {
  const normalized = row.toolName ? normalizeToolName(row.toolName) : "";
  const persistedKind = (row.card as { kind?: unknown } | null)?.kind;
  const isRun =
    persistedKind === "run" ||
    normalized === "workers.run" ||
    normalized === "runs.get";
  if (!isRun) return null;
  const result = asRecord(row.result_preview);
  const nestedRun = asRecord(result?.run);
  const runId =
    optionalString(row.run_id) ??
    optionalString(result?.run_id) ??
    optionalString(nestedRun?.run_id) ??
    optionalString(nestedRun?.id);
  if (!runId) return null;
  const workerId =
    optionalString(row.worker_id) ?? optionalString(nestedRun?.worker_id);
  const workerName =
    optionalString(nestedRun?.worker_name) ?? workerId ?? "Worker run";
  const callId = row.callId || row.id;
  return {
    kind: "run",
    callId,
    card_id: row.id || callId,
    status: normalizeStatus(row.status),
    toolName: normalized || row.toolName || undefined,
    runId,
    ...(workerId ? { workerId } : {}),
    workerName,
    ...(row.streams ? { streams: row.streams } : {}),
    actions:
      row.actions && row.actions.length
        ? (row.actions as RunCard["actions"])
        : [
            {
              id: "open_run",
              label: "View run",
              method: "GET",
              href: `/runs/${runId}?tab=logs`,
            },
          ],
  };
}

function toCard(row: ConversationToolCardRow): ToolCard {
  return toWorkerListCard(row) ?? toRunCard(row) ?? toGenericCard(row);
}

export function rehydrateConversation(detail: ConversationDetail): ChatMessage[] {
  const messages = Array.isArray(detail?.messages) ? detail.messages : [];
  const toolCards = Array.isArray(detail?.tool_cards) ? detail.tool_cards : [];

  const timeline: TimelineItem[] = [];
  for (const row of messages) {
    timeline.push({ kind: "message", ts: row.created_at || "", row });
  }
  for (const row of toolCards) {
    if (row.toolName && isInternalToolName(row.toolName)) continue;
    timeline.push({ kind: "card", ts: row.created_at || "", row });
  }

  // Stable chronological sort. Items without a timestamp keep their relative
  // insertion order (messages first, then cards) via the index tiebreak.
  timeline.sort((a, b) => {
    if (a.ts && b.ts && a.ts !== b.ts) return a.ts < b.ts ? -1 : 1;
    return 0;
  });

  const out: ChatMessage[] = [];
  let activeAssistant: ChatMessage | null = null;

  for (const item of timeline) {
    if (item.kind === "message") {
      const { row } = item;
      if (row.role === "user") {
        activeAssistant = null;
        out.push({ id: row.id, role: "user", text: row.content || "" });
      } else if (row.role === "assistant") {
        const text = (row.content || "").trim();
        const parts: MsgPart[] = text
          ? [{ type: "text", text, streaming: false }]
          : [];
        const msg: ChatMessage = { id: row.id, role: "assistant", parts };
        out.push(msg);
        activeAssistant = msg;
      }
      // role === "tool": represented by its persisted card; skip.
    } else {
      // tool card → append to the active assistant turn (open one if needed)
      const part: MsgPart = { type: "tool-card", card: toCard(item.row) };
      if (!activeAssistant) {
        activeAssistant = {
          id: `a-rehydrate-${item.row.id}`,
          role: "assistant",
          parts: [],
        };
        out.push(activeAssistant);
      }
      activeAssistant.parts = [...(activeAssistant.parts ?? []), part];
    }
  }

  return out;
}
