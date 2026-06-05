"use client";

/**
 * useChatStream -- LIVE SSE wiring
 *
 * Sends messages to POST /chat via fetch() + ReadableStream SSE parsing
 * (EventSource is GET-only; the chat endpoint requires a POST body).
 *
 * SSE frame format from the backend:
 *   data: <json>\n\n
 *   : keepalive\n\n   (ignored)
 *
 * Each JSON payload is a ChatSSEEvent; events are folded into ChatMessage[]
 * via reduceSSEEvent() which is also exported for unit testing.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { apiProxyPath, getActiveWorkspaceId } from "@/lib/api";
import type { AttachedFile, ChatMessage, ToolCard } from "./emily-chat-types";

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
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const sendMessage = useCallback(
    (text: string, files?: AttachedFile[]) => {
      if (!text.trim() && (!files || files.length === 0)) return;

      // Abort any previous in-flight request
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setError(null);

      const userMsg: ChatMessage = {
        id: `u-${Date.now()}`,
        role: "user",
        text,
        ...(files && files.length > 0 ? { files } : {}),
      };
      setMessages((prev) => [...prev, userMsg]);
      setIsStreaming(true);

      // Generate a stable assistant message ID client-side.
      // The backend will persist it and return the real DB id in the finish event.
      const assistantMsgId = `a-${Date.now()}`;

      // We read conversationId from the ref so we can pass it in the body even
      // when the closure over state would be stale.
      const currentConversationId = conversationId;

      (async () => {
        try {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };
          const workspaceId = getActiveWorkspaceId();
          if (workspaceId) {
            headers["x-workeros-workspace"] = workspaceId;
          }

          const body: Record<string, unknown> = { message: text };
          if (currentConversationId) {
            body.conversation_id = currentConversationId;
          }

          const resp = await fetch(apiProxyPath("/chat"), {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
          });

          if (!resp.ok || !resp.body) {
            let errText = "";
            try {
              const j = await resp.json();
              errText =
                typeof j?.detail === "string" ? j.detail : JSON.stringify(j);
            } catch {
              errText = resp.statusText || `HTTP ${resp.status}`;
            }
            throw new Error(errText || `HTTP ${resp.status}`);
          }

          const reader = resp.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // SSE frames are separated by double newlines
            const frames = buffer.split("\n\n");
            // Keep the last incomplete frame in the buffer
            buffer = frames.pop() ?? "";

            for (const frame of frames) {
              // Skip keepalive comments (": keepalive")
              if (!frame.trim() || frame.trimStart().startsWith(":")) continue;

              // Collect data lines (strip "data: " prefix)
              const dataLines = frame
                .split("\n")
                .filter((line) => line.startsWith("data: "))
                .map((line) => line.slice(6));

              if (dataLines.length === 0) continue;

              const raw = dataLines.join("");
              let event: ChatSSEEvent;
              try {
                event = JSON.parse(raw) as ChatSSEEvent;
              } catch {
                continue;
              }

              // Handle conversation_id from chat.meta
              if (event.type === "chat.meta" && event.conversation_id) {
                setConversationId(event.conversation_id);
              }

              // Fold event into messages
              setMessages((prev) => reduceSSEEvent(prev, event, assistantMsgId));

              if (event.type === "finish" || event.type === "error") {
                break;
              }
            }
          }
        } catch (err: unknown) {
          if (err instanceof DOMException && err.name === "AbortError") {
            // User aborted or component unmounted -- not an error
            return;
          }
          const msg =
            err instanceof Error ? err.message : "Stream error";
          setError(msg);
          // Add an error part to the assistant message if one was started
          setMessages((prev) => {
            const hasAssistant = prev.some((m) => m.id === assistantMsgId);
            if (!hasAssistant) return prev;
            return prev.map((m) => {
              if (m.id !== assistantMsgId || m.role !== "assistant") return m;
              const parts = m.parts ?? [];
              const lastPart = parts[parts.length - 1];
              if (lastPart?.type === "text" && lastPart.streaming) {
                return {
                  ...m,
                  parts: [
                    ...parts.slice(0, -1),
                    { type: "text" as const, text: lastPart.text, streaming: false },
                  ],
                };
              }
              return m;
            });
          });
        } finally {
          setIsStreaming(false);
        }
      })();
    },
    [conversationId]
  );

  return { messages, conversationId, isStreaming, error, sendMessage };
}

// ── Event reducer ─────────────────────────────────────────────────────────────
// Reduces a single SSE event into the messages array.
// Exported for unit testing.

import type {
  ChatSSEEvent,
  MsgPart,
  GenericToolCard,
  ToolCard as ToolCardType,
} from "./emily-chat-types";

/**
 * Extract the effective card_id from any tool event.
 * The live backend puts id in event.card.id; the enriched v2 protocol also
 * populates event.card_id for convenience. Support both.
 */
function resolveCardId(
  event: Extract<ChatSSEEvent, { callId: string }>
): string | undefined {
  if ("card_id" in event && typeof event.card_id === "string") {
    return event.card_id;
  }
  if ("card" in event && event.card && typeof (event.card as { id?: unknown }).id === "string") {
    return (event.card as { id: string }).id;
  }
  // Fall back to callId as the card identity
  return event.callId || undefined;
}

export function reduceSSEEvent(
  prev: ChatMessage[],
  event: ChatSSEEvent,
  assistantMsgId: string
): ChatMessage[] {
  switch (event.type) {
    case "chat.meta":
      return prev;

    case "text": {
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
                {
                  type: "text" as const,
                  text: lastPart.text + event.text,
                  streaming: true,
                },
              ],
            };
          }
          return {
            ...m,
            parts: [
              ...parts,
              { type: "text" as const, text: event.text, streaming: true },
            ],
          };
        });
      }
      return [
        ...prev,
        {
          id: assistantMsgId,
          role: "assistant",
          parts: [{ type: "text" as const, text: event.text, streaming: true }],
        },
      ];
    }

    case "tool-call": {
      if (!event.callId) return prev;

      // Use card metadata from the event if available, otherwise synthesise.
      const cardId = resolveCardId(event) ?? event.callId;
      const cardMeta = event.card;
      const card: GenericToolCard = {
        kind: "generic",
        callId: event.callId,
        card_id: cardId,
        toolName: event.toolName,
        title: cardMeta?.title ?? event.toolName.replace(/__/g, ".").replace(/_/g, " "),
        preview: event.args_preview as Record<string, unknown> | undefined,
        status: cardMeta?.status ?? "running",
        ...(event.resource ? {} : {}),
        ...(event.streams ? { streams: event.streams } : {}),
        ...(event.actions ? { actions: event.actions } : {}),
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

    case "tool-progress":
    case "tool-resource":
    case "tool-action-required": {
      const cardId = resolveCardId(event);
      if (!cardId) return prev;

      const newStatus = event.type === "tool-progress" ? event.status : undefined;

      return prev.map((m) => {
        if (m.role !== "assistant" || !m.parts) return m;
        const updatedParts = m.parts.map((p) => {
          if (p.type !== "tool-card" || p.card.card_id !== cardId) return p;
          const updatedCard: ToolCard = {
            ...p.card,
            ...(newStatus !== undefined ? { status: newStatus } : {}),
            ...(event.actions ? { actions: event.actions } : {}),
            ...(event.type === "tool-resource" && event.streams
              ? { streams: event.streams }
              : {}),
          } as ToolCard;
          return { type: "tool-card" as const, card: updatedCard };
        });
        return { ...m, parts: updatedParts };
      });
    }

    case "tool-result": {
      if (!event.callId) return prev;
      const cardId = resolveCardId(event);
      if (!cardId) return prev;

      return prev.map((m) => {
        if (m.role !== "assistant" || !m.parts) return m;
        const updatedParts = m.parts.map((p) => {
          if (p.type !== "tool-card" || p.card.card_id !== cardId) return p;
          const updatedCard: ToolCard = {
            ...p.card,
            status: event.card?.status ?? (event.isError ? "failed" : "completed"),
            ...(event.actions ? { actions: event.actions } : {}),
            ...(event.streams ? { streams: event.streams } : {}),
          } as ToolCard;
          return { type: "tool-card" as const, card: updatedCard };
        });
        return { ...m, parts: updatedParts };
      });
    }

    case "finish": {
      // Mark all streaming text parts as done and reconcile cards from finish.cards
      return prev.map((m) => {
        if (m.role !== "assistant" || !m.parts) return m;
        const reconciledParts = m.parts.map((p) => {
          if (p.type === "text" && p.streaming) {
            return { ...p, streaming: false };
          }
          if (p.type === "tool-card" && event.cards) {
            const reconciled = event.cards?.find(
              (c) => c.id === p.card.card_id || c.callId === p.card.callId
            );
            if (reconciled) {
              return {
                type: "tool-card" as const,
                card: { ...p.card, status: reconciled.status } as ToolCard,
              };
            }
          }
          return p;
        });
        return { ...m, parts: reconciledParts };
      });
    }

    case "error":
      return prev;

    default:
      return prev;
  }
}
