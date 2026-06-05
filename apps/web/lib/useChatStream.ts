"use client";

/**
 * useChatStream -- DATA SEAM
 *
 * This hook is the single wiring point for live SSE data.
 * Currently returns STUB messages for visual development.
 *
 * TO WIRE THE BACKEND:
 * 1. Replace the `useEffect` body with a real `EventSource` (or fetch-based SSE).
 * 2. Parse each SSE `data:` line as a `ChatSSEEvent`.
 * 3. Reduce events into `ChatMessage[]` using the event reducer pattern below.
 * 4. Keep the returned interface identical -- no other files need changing.
 *
 * The backend endpoint is: POST /chat
 * Headers: x-workeros-workspace: <workspace_id>, Content-Type: application/json
 * Body: { conversation_id?, message, files? }
 *
 * SSE event types: ChatMetaEvent | TokenEvent | ToolCallEvent | ToolResultEvent
 *   | ToolProgressEvent | ToolResourceEvent | ToolActionRequiredEvent | FinishEvent
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { AttachedFile, ChatMessage, ToolCard } from "./emily-chat-types";
import { STUB_MESSAGES } from "./emily-chat-stub";

export interface ChatStreamState {
  messages: ChatMessage[];
  conversationId: string | null;
  isStreaming: boolean;
  error: string | null;
  sendMessage: (text: string, files?: AttachedFile[]) => void;
}

export function useChatStream(): ChatStreamState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stubTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // STUB: Load mock conversation after mount.
  // Replace with: fetch GET /conversations/{id} on mount when conversation_id is stored.
  useEffect(() => {
    stubTimerRef.current = setTimeout(() => {
      setMessages(STUB_MESSAGES);
      setConversationId("conv_stub_001");
    }, 350);
    return () => {
      if (stubTimerRef.current) clearTimeout(stubTimerRef.current);
    };
  }, []);

  // sendMessage -- STUB: echoes user message and returns a canned reply.
  // Replace with: POST /chat with EventSource reading the response body.
  const sendMessage = useCallback(
    (text: string, files?: AttachedFile[]) => {
      if (!text.trim() && (!files || files.length === 0)) return;
      setError(null);

      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        text,
        ...(files && files.length > 0 ? { files } : {}),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsStreaming(true);

      // STUB reply -- replace with real SSE event reducer.
      stubTimerRef.current = setTimeout(() => {
        const replyText = text
          ? `Got it: "${text}". Processing now.`
          : `Got it. Looking at ${files && files.length === 1 ? "that file" : "those files"} now.`;

        const assistantMsg: ChatMessage = {
          id: `a-${Date.now()}`,
          role: "assistant",
          parts: [{ type: "text", text: replyText }],
        };
        setMessages((prev) => [...prev, assistantMsg]);
        setIsStreaming(false);
      }, 1100);
    },
    []
  );

  return { messages, conversationId, isStreaming, error, sendMessage };
}

// ── Event reducer (used by the real wiring when ready) ────────────────────────
// This function reduces a single SSE event into the messages array.
// Exported so the real EventSource handler can import and use it.

import type {
  ChatSSEEvent,
  MsgPart,
  WorkerCreateCard,
  RunCard,
  ConnectServiceCard,
  ApprovalCard,
  WorkerListCard,
  GenericToolCard,
} from "./emily-chat-types";

export function reduceSSEEvent(
  prev: ChatMessage[],
  event: ChatSSEEvent,
  assistantMsgId: string
): ChatMessage[] {
  switch (event.type) {
    case "chat.meta":
      return prev;

    case "text": {
      // Find streaming assistant message or create one
      const existing = prev.find((m) => m.id === assistantMsgId);
      if (existing && existing.role === "assistant") {
        return prev.map((m) => {
          if (m.id !== assistantMsgId || m.role !== "assistant") return m;
          const parts = m.parts ?? [];
          const lastPart = parts[parts.length - 1];
          if (lastPart?.type === "text") {
            return {
              ...m,
              parts: [
                ...parts.slice(0, -1),
                { type: "text", text: lastPart.text + event.text, streaming: true },
              ],
            };
          }
          return {
            ...m,
            parts: [...parts, { type: "text", text: event.text, streaming: true }],
          };
        });
      }
      return [
        ...prev,
        {
          id: assistantMsgId,
          role: "assistant",
          parts: [{ type: "text", text: event.text, streaming: true }],
        },
      ];
    }

    case "tool-call": {
      if (!event.card) return prev;
      const card: GenericToolCard = {
        kind: "generic",
        callId: event.callId,
        card_id: event.card.id,
        toolName: event.toolName,
        title: event.card.title,
        preview: event.args_preview,
        status: event.card.status,
      };
      const newPart: MsgPart = { type: "tool-card", card };
      const existing = prev.find((m) => m.id === assistantMsgId);
      if (existing && existing.role === "assistant") {
        return prev.map((m) =>
          m.id === assistantMsgId && m.role === "assistant"
            ? { ...m, parts: [...(m.parts ?? []), newPart] }
            : m
        );
      }
      return [
        ...prev,
        { id: assistantMsgId, role: "assistant", parts: [newPart] },
      ];
    }

    case "tool-result":
    case "tool-progress":
    case "tool-resource":
    case "tool-action-required": {
      // Update the matching card in the existing message
      const cardId =
        event.type === "tool-result"
          ? event.card?.id
          : (event as { card_id: string }).card_id;
      if (!cardId) return prev;

      return prev.map((m) => {
        if (m.role !== "assistant" || !m.parts) return m;
        const updatedParts = m.parts.map((p) => {
          if (p.type !== "tool-card" || p.card.card_id !== cardId) return p;
          const updatedCard: ToolCard = {
            ...p.card,
            status:
              event.type === "tool-result"
                ? (event.card?.status ?? p.card.status)
                : (event as { status?: string }).status
                  ? ((event as { status: string }).status as ToolCard["status"])
                  : p.card.status,
            ...(event.type === "tool-result" && event.actions
              ? { actions: event.actions }
              : {}),
          } as ToolCard;
          return { type: "tool-card" as const, card: updatedCard };
        });
        return { ...m, parts: updatedParts };
      });
    }

    case "finish": {
      // Mark streaming text as done
      return prev.map((m) => {
        if (m.role !== "assistant" || !m.parts) return m;
        return {
          ...m,
          parts: m.parts.map((p) =>
            p.type === "text" && p.streaming ? { ...p, streaming: false } : p
          ),
        };
      });
    }

    case "error":
      return prev;

    default:
      return prev;
  }
}
