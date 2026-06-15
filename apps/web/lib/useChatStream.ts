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
import { api, apiProxyPath, getActiveWorkspaceId } from "@/lib/api";
import type { AttachedFile, ChatMessage } from "./emily-chat-types";
import {
  CONVERSATION_STORAGE_KEY,
  readStoredConversationId,
  writeStoredConversationId,
  clearStoredConversationId,
} from "./emily-chat-storage";
import { rehydrateConversation } from "./emily-chat-rehydrate";
import { buildMessageWithAttachments } from "./emily/attachments";

export interface ChatStreamState {
  messages: ChatMessage[];
  conversationId: string | null;
  isStreaming: boolean;
  /** True while the stored conversation is being fetched + rehydrated on mount. */
  isHydrating: boolean;
  error: string | null;
  sendMessage: (text: string, files?: AttachedFile[]) => void;
  /** Reset to a fresh conversation. The previous one stays retrievable server-side. */
  newSession: () => void;
  /** Load a past conversation into the live stream (Emily history rail). */
  loadConversation: (id: string) => void;
}

export function useChatStream(): ChatStreamState {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isHydrating, setIsHydrating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Keep localStorage in sync whenever the active conversation id changes so the
  // id survives modal close/open, fullscreen toggle, navigation, and reload.
  useEffect(() => {
    if (conversationId) {
      writeStoredConversationId(conversationId);
    }
  }, [conversationId]);

  // On mount: if a conversation id was persisted, fetch it from the server and
  // rehydrate messages + tool cards into the live stream shape. This is what
  // makes the dock/full-page survive unmount and a browser reload.
  useEffect(() => {
    const storedId = readStoredConversationId();
    if (!storedId) return;

    let cancelled = false;
    setIsHydrating(true);
    (async () => {
      try {
        const detail = await api.conversations.get(storedId);
        if (cancelled) return;
        const hydrated = rehydrateConversation(detail);
        setMessages(hydrated);
        setConversationId(storedId);
      } catch {
        // Stored id no longer resolves (deleted, wrong workspace, 404). Drop it
        // so we start clean instead of looping on a dead id.
        if (!cancelled) clearStoredConversationId();
      } finally {
        if (!cancelled) setIsHydrating(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Cross-tab / cross-instance sync: if another mounted instance (e.g. the dock
  // while another chat surface is open, or a second tab) starts a new session or
  // switches conversation, mirror it here.
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== CONVERSATION_STORAGE_KEY) return;
      const next = e.newValue;
      if (!next) {
        // Cleared elsewhere → reset to fresh.
        setMessages([]);
        setConversationId(null);
        return;
      }
      if (next === conversationId) return;
      (async () => {
        try {
          const detail = await api.conversations.get(next);
          const hydrated = rehydrateConversation(detail);
          setMessages(hydrated);
          setConversationId(next);
        } catch {
          /* ignore */
        }
      })();
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [conversationId]);

  // Abort any in-flight stream on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // #591: Subscribe to the underlying run SSE stream for tool cards stuck in
  // "running" status. When workers.run triggers a run, the backend intentionally
  // leaves the card at status="running" because the run executes asynchronously.
  // Without this effect, the "Starting worker run" spinner stays forever because
  // no code ever connected the card to the run's completion event.
  //
  // Strategy: track subscribed card_ids in a ref (avoids re-creating sources on
  // every render). For each unsubscribed running card that has a stream URL,
  // open an EventSource. On a "finish" part, flip the card to completed/failed.
  // On stream error, fall back to a one-shot REST poll of the run status.
  const subscribedCardIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    const newSources: { cardId: string; source: EventSource }[] = [];

    for (const msg of messages) {
      if (msg.role !== "assistant" || !msg.parts) continue;
      for (const part of msg.parts) {
        if (part.type !== "tool-card") continue;
        const card = part.card;
        if (card.status !== "running") continue;
        if (!card.streams?.parts) continue;
        if (subscribedCardIds.current.has(card.card_id)) continue;

        const cardId = card.card_id;
        const streamPath = card.streams.parts;
        // Extract run_id for fallback REST poll: path is /runs/{id}/stream
        const runId = streamPath.match(/\/runs\/([^/]+)\//)?.[1];

        subscribedCardIds.current.add(cardId);

        const source = new EventSource(apiProxyPath(streamPath, true));
        newSources.push({ cardId, source });

        const applyFinalStatus = (finalStatus: "completed" | "failed") => {
          subscribedCardIds.current.delete(cardId);
          setMessages((prev) =>
            prev.map((m) => {
              if (m.role !== "assistant" || !m.parts) return m;
              return {
                ...m,
                parts: m.parts.map((p) => {
                  if (p.type !== "tool-card" || p.card.card_id !== cardId) return p;
                  const tc = p.card as GenericToolCard;
                  return {
                    type: "tool-card" as const,
                    card: {
                      ...p.card,
                      status: finalStatus,
                      ...("toolName" in tc
                        ? { title: getToolCardTitle(tc.toolName, finalStatus) }
                        : {}),
                    } as ToolCard,
                  };
                }),
              };
            })
          );
        };

        source.addEventListener("part", (event) => {
          try {
            const data = JSON.parse((event as MessageEvent).data) as { type?: string; status?: string };
            if (data.type === "finish") {
              source.close();
              applyFinalStatus(data.status === "completed" ? "completed" : "failed");
            }
          } catch { /* ignore malformed SSE frames */ }
        });

        source.onerror = () => {
          source.close();
          // Fallback: one-shot REST poll to get final run status
          if (!runId) return;
          void fetch(apiProxyPath(`/runs/${runId}`))
            .then((r) => r.ok ? r.json() : null)
            .then((run: { status?: string } | null) => {
              if (!run) return;
              if (run.status === "completed" || run.status === "failed") {
                applyFinalStatus(run.status as "completed" | "failed");
              }
            })
            .catch(() => { /* network error — leave card as-is */ });
        };
      }
    }

    return () => {
      for (const { cardId, source } of newSources) {
        source.close();
        subscribedCardIds.current.delete(cardId);
      }
    };
  }, [messages]);

  const newSession = useCallback(() => {
    abortRef.current?.abort();
    clearStoredConversationId();
    subscribedCardIds.current.clear();
    setMessages([]);
    setConversationId(null);
    setError(null);
    setIsStreaming(false);
  }, []);

  // Load a past conversation into this instance (same-instance switch; the
  // storage event only syncs OTHER tabs, so we hydrate directly here).
  const loadConversation = useCallback(
    (id: string) => {
      if (!id || id === conversationId) return;
      abortRef.current?.abort();
      subscribedCardIds.current.clear();
      setIsStreaming(false);
      setError(null);
      setIsHydrating(true);
      (async () => {
        try {
          const detail = await api.conversations.get(id);
          const hydrated = rehydrateConversation(detail);
          setMessages(hydrated);
          setConversationId(id);
          writeStoredConversationId(id);
        } catch {
          setError("Could not load that conversation.");
        } finally {
          setIsHydrating(false);
        }
      })();
    },
    [conversationId],
  );

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

          // #778: ride attachment text along in the message so Emily sees it.
          const body: Record<string, unknown> = { message: buildMessageWithAttachments(text, files) };
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

              if (event.type === "error") {
                setError(sseErrorMessage(event));
                break;
              }
              if (event.type === "finish") {
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

  return {
    messages,
    conversationId,
    isStreaming,
    isHydrating,
    error,
    sendMessage,
    newSession,
    loadConversation,
  };
}

// ── Event reducer ─────────────────────────────────────────────────────────────
// Reduces a single SSE event into the messages array.
// Exported for unit testing.

import type {
  CardStatus,
  ChatSSEEvent,
  RunCard,
  MsgPart,
  GenericToolCard,
  ToolCard,
  WorkerListCard,
} from "./emily-chat-types";

type ToolLabel = {
  running: string;
  completed: string;
  failed?: string;
};

const INTERNAL_TOOL_NAMES = new Set([
  "finish_with_outputs",
  "finish",
  "final",
  "finalize",
  "submit_final",
  "submit_final_answer",
]);

const TOOL_LABELS: Record<string, ToolLabel> = {
  "approvals.list_pending": {
    running: "Checking approvals",
    completed: "Checked approvals",
  },
  "brain.list": {
    running: "Listing brain packs",
    completed: "Listed brain packs",
  },
  "brain.read": {
    running: "Reading brain pack",
    completed: "Read brain pack",
  },
  "brain.write": {
    running: "Updating brain pack",
    completed: "Updated brain pack",
  },
  "connections.add_mcp": {
    running: "Adding MCP connection",
    completed: "Added MCP connection",
  },
  "connections.list": {
    running: "Checking connections",
    completed: "Checked connections",
  },
  "contexts.list": {
    running: "Listing brain packs",
    completed: "Listed brain packs",
  },
  "contexts.read": {
    running: "Reading brain pack",
    completed: "Read brain pack",
  },
  "contexts.write": {
    running: "Updating brain pack",
    completed: "Updated brain pack",
  },
  "mcp_tools.delete": {
    running: "Removing custom tool",
    completed: "Removed custom tool",
  },
  "mcp_tools.list": {
    running: "Listing custom tools",
    completed: "Listed custom tools",
  },
  "mcp_tools.register": {
    running: "Registering custom tool",
    completed: "Registered custom tool",
  },
  "mcp_tools.update": {
    running: "Updating custom tool",
    completed: "Updated custom tool",
  },
  "runs.cancel": {
    running: "Cancelling run",
    completed: "Cancelled run",
  },
  "runs.get": {
    running: "Opening run details",
    completed: "Opened run details",
  },
  "runs.list": {
    running: "Reviewing runs",
    completed: "Reviewed runs",
  },
  "runs.watch": {
    running: "Watching run progress",
    completed: "Watched run progress",
  },
  "secrets.list": {
    running: "Checking secrets",
    completed: "Checked secrets",
  },
  "secrets.list_names": {
    running: "Checking secrets",
    completed: "Checked secrets",
  },
  "secrets.set": {
    running: "Saving secret",
    completed: "Saved secret",
  },
  "slack.list_channels": {
    running: "Checking Slack channels",
    completed: "Checked Slack channels",
  },
  "slack.read_channel": {
    running: "Reading Slack",
    completed: "Read Slack",
  },
  "web.search": {
    running: "Searching the web",
    completed: "Searched the web",
  },
  web_search: {
    running: "Searching the web",
    completed: "Searched the web",
  },
  web_search_call: {
    running: "Searching the web",
    completed: "Searched the web",
  },
  "workers.create": {
    running: "Creating worker",
    completed: "Created worker",
  },
  "workers.get": {
    running: "Opening worker details",
    completed: "Opened worker details",
  },
  "workers.list": {
    running: "Listing your workers",
    completed: "Listed your workers",
  },
  "workers.list_all": {
    running: "Listing your workers",
    completed: "Listed your workers",
  },
  "workers.run": {
    running: "Starting worker run",
    completed: "Started worker run",
  },
  "workers.update": {
    running: "Updating worker",
    completed: "Updated worker",
  },
};

const FALLBACK_VERBS: Record<
  string,
  { running: string; completed: string }
> = {
  add: { running: "Adding", completed: "Added" },
  cancel: { running: "Cancelling", completed: "Cancelled" },
  create: { running: "Creating", completed: "Created" },
  delete: { running: "Deleting", completed: "Deleted" },
  fetch: { running: "Fetching", completed: "Fetched" },
  get: { running: "Reviewing", completed: "Reviewed" },
  list: { running: "Listing", completed: "Listed" },
  read: { running: "Reading", completed: "Read" },
  register: { running: "Registering", completed: "Registered" },
  run: { running: "Starting", completed: "Started" },
  search: { running: "Searching", completed: "Searched" },
  set: { running: "Saving", completed: "Saved" },
  update: { running: "Updating", completed: "Updated" },
  watch: { running: "Watching", completed: "Watched" },
  write: { running: "Writing", completed: "Wrote" },
};

export function normalizeToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/__+/g, ".")
    .replace(/-+/g, "_");
}

export function isInternalToolName(toolName: string): boolean {
  return INTERNAL_TOOL_NAMES.has(normalizeToolName(toolName));
}

function sentenceCase(value: string): string {
  if (!value) return "Working";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function humanizeToolName(toolName: string): string {
  const normalized = normalizeToolName(toolName);
  const slug = normalized.split(".").pop() || normalized;
  const words = slug.replace(/_+/g, " ").trim();
  return sentenceCase(words);
}

function fallbackToolLabel(toolName: string, done: boolean): string {
  const normalized = normalizeToolName(toolName);
  const slug = normalized.split(".").pop() || normalized;
  const [verb, ...rest] = slug.split("_").filter(Boolean);
  const inflection = FALLBACK_VERBS[verb];
  if (!inflection || rest.length === 0) {
    return humanizeToolName(toolName);
  }
  const object = rest.join(" ");
  return `${done ? inflection.completed : inflection.running} ${object}`;
}

export function getToolCardTitle(toolName: string, status: ToolCard["status"]): string {
  const normalized = normalizeToolName(toolName);
  const labels = TOOL_LABELS[normalized];
  const done = status === "completed";
  const failed = status === "failed" || status === "error";

  if (labels) {
    if (failed && labels.failed) return labels.failed;
    return done ? labels.completed : labels.running;
  }

  return fallbackToolLabel(toolName, done);
}

function normalizeCardStatus(status: unknown): CardStatus {
  if (status === "succeeded") return "completed";
  if (typeof status === "string") return status as CardStatus;
  return "completed";
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function sseErrorMessage(event: Extract<ChatSSEEvent, { type: "error" }>): string {
  const message =
    optionalString(event.error) ??
    optionalString((event as { message?: unknown }).message) ??
    optionalString((event as { detail?: unknown }).detail);
  return message ?? "Emily could not complete that request.";
}

function appendAssistantError(
  prev: ChatMessage[],
  assistantMsgId: string,
  message: string
): ChatMessage[] {
  const errorPart: MsgPart = { type: "text", text: message, streaming: false };
  const existing = prev.find((m) => m.id === assistantMsgId);
  if (existing && existing.role === "assistant") {
    return prev.map((m) =>
      m.id === assistantMsgId && m.role === "assistant"
        ? { ...m, parts: [...(m.parts ?? []), errorPart] }
        : m
    );
  }
  return [
    ...prev,
    {
      id: assistantMsgId,
      role: "assistant",
      parts: [errorPart],
    },
  ];
}

/**
 * Map a workers.list_all tool result (live SSE or persisted result_preview)
 * to WorkerListCard rows. Returns null when the value has no workers array.
 * Shared with rehydration (#842) so a reloaded conversation reconstructs the
 * same interactive card the live stream produced.
 */
export function workerRowsFromResult(
  result: unknown
): WorkerListCard["workers"] | null {
  const workers = asRecord(result)?.workers;
  if (!Array.isArray(workers)) return null;
  return workers.reduce<WorkerListCard["workers"]>((acc, worker) => {
    const row = asRecord(worker);
    const id = optionalString(row?.id);
    if (!id) return acc;
    const trigger = optionalString(row?.trigger);
    acc.push({
      id,
      name: optionalString(row?.title) ?? optionalString(row?.name) ?? id,
      ...(trigger ? { trigger } : {}),
      enabled: row?.enabled === undefined ? true : Boolean(row.enabled),
    });
    return acc;
  }, []);
}

function workerListCardFromResult(
  event: Extract<ChatSSEEvent, { type: "tool-result" }>,
  existing: ToolCard
): WorkerListCard | null {
  const normalizedTool = event.toolName ? normalizeToolName(event.toolName) : "";
  const isWorkerList =
    event.card?.kind === "worker-list" || normalizedTool === "workers.list_all";
  if (!isWorkerList) return null;
  const workers = workerRowsFromResult(event.result);
  if (!workers) return null;

  return {
    kind: "worker-list",
    callId: existing.callId,
    card_id: existing.card_id,
    status: normalizeCardStatus(event.card?.status ?? (event.isError ? "failed" : "completed")),
    actions: event.actions,
    streams: event.streams,
    args: existing.args ?? ("preview" in existing ? existing.preview : undefined),
    result: event.result,
    workers,
  };
}

function runCardFromResult(
  event: Extract<ChatSSEEvent, { type: "tool-result" }>,
  existing: ToolCard
): RunCard | null {
  const result = asRecord(event.result);
  const nestedRun = asRecord(result?.run);
  const normalizedTool = event.toolName ? normalizeToolName(event.toolName) : "";
  const isRun =
    event.card?.kind === "run" ||
    normalizedTool === "workers.run" ||
    normalizedTool === "runs.get";
  const resource = event.resource?.kind === "run" ? event.resource : null;
  const runId =
    optionalString(result?.run_id) ??
    optionalString(nestedRun?.run_id) ??
    optionalString(nestedRun?.id) ??
    optionalString(resource?.run_id);
  if (!isRun || !runId) return null;

  const args = asRecord(existing.args) ?? ("preview" in existing ? asRecord(existing.preview) : null);
  const workerId =
    optionalString(resource?.worker_id) ??
    optionalString(nestedRun?.worker_id) ??
    optionalString(args?.id);
  const workerName = optionalString(resource?.worker_name) ?? workerId ?? "Worker run";
  const actions =
    event.actions && event.actions.length > 0
      ? event.actions
      : existing.actions && existing.actions.length > 0
        ? existing.actions
        : normalizedTool === "runs.get"
          ? [
              {
                id: "open_run",
                label: "View run",
                method: "GET" as const,
                href: `/runs?sel=${encodeURIComponent(runId)}&tab=Trace`,
              },
            ]
          : event.actions;

  return {
    kind: "run",
    callId: existing.callId,
    card_id: existing.card_id,
    status: normalizeCardStatus(event.card?.status ?? (event.isError ? "failed" : "running")),
    actions,
    streams: event.streams,
    args: existing.args ?? ("preview" in existing ? existing.preview : undefined),
    result: event.result,
    toolName: normalizedTool || event.toolName,
    runId,
    workerId,
    workerName,
  };
}

function toolCardFromResult(
  event: Extract<ChatSSEEvent, { type: "tool-result" }>,
  existing: ToolCard
): ToolCard | null {
  return workerListCardFromResult(event, existing) ?? runCardFromResult(event, existing);
}

function toolCardToolName(card: ToolCard): string | null {
  return "toolName" in card && typeof card.toolName === "string" ? card.toolName : null;
}

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
      if (isInternalToolName(event.toolName)) return prev;

      // Use card metadata from the event if available, otherwise synthesise.
      const cardId = resolveCardId(event) ?? event.callId;
      const cardMeta = event.card;
      const status = normalizeCardStatus(cardMeta?.status ?? "running");
      const card: GenericToolCard = {
        kind: "generic",
        callId: event.callId,
        card_id: cardId,
        toolName: event.toolName,
        title: event.card?.title ?? getToolCardTitle(event.toolName, status),
        args: event.args_preview ?? event.args,
        preview: event.args_preview as Record<string, unknown> | undefined,
        status,
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

      const newStatus = event.type === "tool-progress" ? normalizeCardStatus(event.status) : undefined;

      return prev.map((m) => {
        if (m.role !== "assistant" || !m.parts) return m;
        const updatedParts = m.parts.map((p) => {
          if (p.type !== "tool-card" || p.card.card_id !== cardId) return p;
          const toolName = toolCardToolName(p.card);
          const updatedCard: ToolCard = {
            ...p.card,
            ...(newStatus !== undefined ? { status: newStatus } : {}),
            ...(event.type === "tool-progress" && event.label
              ? { title: event.label }
              : newStatus !== undefined && toolName
                ? { title: getToolCardTitle(toolName, newStatus) }
                : {}),
            ...(event.actions ? { actions: event.actions } : {}),
            ...("streams" in event && event.streams ? { streams: event.streams } : {}),
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
          const specializedCard = toolCardFromResult(event, p.card);
          if (specializedCard) return { type: "tool-card" as const, card: specializedCard };
          const status = event.card?.status ?? (event.isError ? "failed" : "completed");
          const toolName = toolCardToolName(p.card);
          const updatedCard: ToolCard = {
            ...p.card,
            status: normalizeCardStatus(status),
            ...(event.card?.title
              ? { title: event.card.title }
              : toolName
                ? { title: getToolCardTitle(toolName, normalizeCardStatus(status)) }
                : {}),
            result: event.result,
            isError: event.isError,
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
              const toolName = toolCardToolName(p.card);
              return {
                type: "tool-card" as const,
                card: {
                  ...p.card,
                  status: normalizeCardStatus(reconciled.status),
                  ...(toolName
                    ? { title: getToolCardTitle(toolName, normalizeCardStatus(reconciled.status)) }
                    : {}),
                } as ToolCard,
              };
            }
          }
          return p;
        });
        return { ...m, parts: reconciledParts };
      });
    }

    case "error":
      return appendAssistantError(prev, assistantMsgId, sseErrorMessage(event));

    default:
      return prev;
  }
}

export function shouldAutoOpenRunDetails(card: ToolCard): card is RunCard {
  return (
    card.kind === "run" &&
    normalizeToolName(card.toolName || "") === "runs.get" &&
    card.status === "completed" &&
    Boolean(card.runId)
  );
}

export function getAutoOpenRunDetailsHref(card: ToolCard): string | null {
  return shouldAutoOpenRunDetails(card) && card.runId
    ? `/runs?sel=${encodeURIComponent(card.runId)}&tab=Trace`
    : null;
}

// #825: Emily's answers link to app pages as REAL router hrefs (no DOM access /
// page driving — links only). Generalizes getAutoOpenRunDetailsHref across every
// card kind to its in-app route, or null when there's nothing concrete to open.
export function getCardHref(card: ToolCard): string | null {
  switch (card.kind) {
    case "worker-create":
      return card.workerId ? `/workers?sel=${encodeURIComponent(card.workerId)}` : null;
    case "run":
      return card.runId ? `/runs?sel=${encodeURIComponent(card.runId)}` : null;
    case "artifact":
      return card.runId ? `/runs?sel=${encodeURIComponent(card.runId)}&tab=Output` : null;
    case "approval":
      return card.approvalId ? `/approvals?sel=${card.approvalId}` : "/approvals";
    case "connect-service":
      return "/connections";
    case "worker-list":
      return "/workers";
    case "runs-list":
      return "/runs";
    default:
      return null;
  }
}
