/**
 * Emily Chat -- Typed SSE event contract
 *
 * This file defines the interface shapes documented in
 * docs/design/emily-agentic-chat-2026-06-05.md.
 *
 * DATA SEAM: The `useChatStream` hook in components/emily/useChatStream.ts
 * currently returns STUB data. Replace the hook implementation with a real
 * EventSource reading from POST /chat once the backend emits these shapes.
 * Nothing else in the UI layer touches the wire format.
 */

// ── Card taxonomy ─────────────────────────────────────────────────────────────

export type CardKind =
  | "run"
  | "worker-create"
  | "worker-update"
  | "worker-list"
  | "worker-detail"
  | "runs-list"
  | "run-detail"
  | "secrets-status"
  | "secret-set"
  | "connections-list"
  | "mcp-connection"
  | "brain-list"
  | "brain-file"
  | "brain-write"
  | "approvals-list"
  | "slack-channels"
  | "slack-read"
  | "connect-service"
  | "artifact";

export type CardStatus =
  | "starting"
  | "running"
  | "queued"
  | "drafting"
  | "generating"
  | "smoke"
  | "completed"
  | "failed"
  | "cancelled"
  | "pending_approval"
  | "ready"
  | "loading"
  | "error";

export interface CardMeta {
  id: string;
  kind: CardKind;
  title: string;
  status: CardStatus;
}

// ── Resource shapes ───────────────────────────────────────────────────────────

export type Resource =
  | { kind: "worker"; worker_id: string; worker_name?: string }
  | { kind: "run"; run_id: string; worker_id?: string; worker_name?: string }
  | { kind: "connection"; app_name: string; status: "missing" | "expired" | "ok" }
  | { kind: "secret"; secret_name: string }
  | { kind: "approval"; approval_id: string; label?: string };

export interface CardAction {
  id: string;
  label?: string;
  method?: "GET" | "POST" | "DELETE";
  href: string;
  body?: Record<string, unknown>;
}

// ── SSE event shapes (v2 enriched protocol) ──────────────────────────────────

/** Emitted once at stream start. */
export interface ChatMetaEvent {
  type: "chat.meta";
  version: 2;
  conversation_id: string;
  assistant_message_id: string;
  source?: string;
}

/** Token text chunk for streaming assistant text. */
export interface TokenEvent {
  type: "text";
  text: string;
  version?: 2;
  conversation_id?: string;
}

/** Tool call -- enriched with card + resource info. */
export interface ToolCallEvent {
  type: "tool-call";
  version?: 2;
  conversation_id?: string;
  message_id?: string;
  callId: string;
  toolName: string;
  /** args is the raw (possibly redacted) args object as emitted by the backend. */
  args?: Record<string, unknown>;
  card?: CardMeta;
  resource?: Resource;
  streams?: { events: string; parts: string };
  actions?: CardAction[];
  args_preview?: Record<string, unknown>;
  redaction?: { args_redacted: boolean };
}

/** Tool result -- card status updated, run handle and actions available. */
export interface ToolResultEvent {
  type: "tool-result";
  version?: 2;
  conversation_id?: string;
  message_id?: string;
  callId: string;
  toolName?: string;
  isError: boolean;
  result: unknown;
  card?: Partial<CardMeta>;
  resource?: Resource;
  streams?: { events: string; parts: string };
  actions?: CardAction[];
}

/** Bridge event for live progress before the run stream connects. */
export interface ToolProgressEvent {
  type: "tool-progress";
  version?: 2;
  conversation_id?: string;
  toolName?: string;
  callId: string;
  /** card_id is present when emitted by the enriched v2 protocol. */
  card_id?: string;
  /** card is present in the live backend shape; card.id == card_id. */
  card?: Partial<CardMeta>;
  resource?: Resource;
  streams?: { events: string; parts: string };
  actions?: CardAction[];
  status: CardStatus;
  stage?: string;
  label?: string;
  percent?: number | null;
}

/** Late-bound resource (e.g., worker created by worker-author after run starts). */
export interface ToolResourceEvent {
  type: "tool-resource";
  version?: 2;
  conversation_id?: string;
  toolName?: string;
  callId: string;
  /** card_id is present when emitted by the enriched v2 protocol. */
  card_id?: string;
  /** card is present in the live backend shape; card.id == card_id. */
  card?: Partial<CardMeta>;
  resource: Resource & {
    created_by_run_id?: string;
    smoke_status?: "passed" | "failed" | "skipped";
    smoke_reason?: string | null;
  };
  streams?: { events: string; parts: string };
  actions?: CardAction[];
}

/** Approval, missing secret, or missing connection requiring user action. */
export interface ToolActionRequiredEvent {
  type: "tool-action-required";
  version?: 2;
  conversation_id?: string;
  toolName?: string;
  callId: string;
  /** card_id is present when emitted by the enriched v2 protocol. */
  card_id?: string;
  /** card is present in the live backend shape; card.id == card_id. */
  card?: Partial<CardMeta>;
  reason?: "missing_connection" | "missing_secret" | "approval_required";
  resource?: Resource;
  actions?: CardAction[];
}

/** Stream finish. */
export interface FinishEvent {
  type: "finish";
  version?: 2;
  conversation_id: string | null;
  /** message_id is the persisted assistant message id (live backend field). */
  message_id?: string | null;
  /** assistant_message_id is the v2 protocol alias for message_id. */
  assistant_message_id?: string | null;
  cards?: Array<{
    id: string;
    callId: string;
    kind: CardKind;
    resource?: Resource;
    status: CardStatus;
  }>;
}

/** Legacy error event. */
export interface ErrorEvent {
  type: "error";
  error: string;
  conversation_id?: string;
}

export type ChatSSEEvent =
  | ChatMetaEvent
  | TokenEvent
  | ToolCallEvent
  | ToolResultEvent
  | ToolProgressEvent
  | ToolResourceEvent
  | ToolActionRequiredEvent
  | FinishEvent
  | ErrorEvent;

// ── UI message model ──────────────────────────────────────────────────────────

export interface AttachedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  /** #778: extracted text content (text-like files), rides along in the message. */
  text?: string;
}

export type MsgPart =
  | { type: "text"; text: string; streaming?: boolean }
  | { type: "tool-card"; card: ToolCard };

export type ToolCard =
  | WorkerCreateCard
  | RunCard
  | ConnectServiceCard
  | ApprovalCard
  | WorkerListCard
  | RunsListCard
  | ArtifactCard
  | GenericToolCard;

interface BaseCard {
  callId: string;
  card_id: string;
  status: CardStatus;
  actions?: CardAction[];
  streams?: { events: string; parts: string };
}

export interface WorkerCreateCard extends BaseCard {
  kind: "worker-create";
  workerName: string;
  workerId?: string;
  smokeStatus?: "passed" | "failed" | "skipped";
  smokeReason?: string | null;
  step: "drafting" | "generating" | "smoke" | "ready" | "failed";
}

export interface RunCard extends BaseCard {
  kind: "run";
  toolName?: string;
  workerName: string;
  workerId?: string;
  runId?: string;
  duration?: string;
  logLines?: number;
  artifact?: { name: string; id: string };
}

export interface ConnectServiceCard extends BaseCard {
  kind: "connect-service";
  appName: string;
  label: string;
  connected: boolean;
  redirectUrl?: string;
}

export interface ApprovalCard extends BaseCard {
  kind: "approval";
  approvalId?: string;
  workerName: string;
  action: string;
  approved: boolean | null;
  brand?: string;
}

export interface WorkerListCard extends BaseCard {
  kind: "worker-list";
  workers: Array<{ id: string; name: string; trigger?: string; enabled: boolean }>;
}

export interface RunsListCard extends BaseCard {
  kind: "runs-list";
  runs: Array<{ id: string; workerName: string; status: CardStatus; createdAt?: string }>;
}

export interface ArtifactCard extends BaseCard {
  kind: "artifact";
  runId: string;
  artifactId: string;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
  downloadUrl: string;
}

export interface GenericToolCard extends BaseCard {
  kind: "generic";
  toolName: string;
  title: string;
  preview?: Record<string, unknown>;
  isError?: boolean;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text?: string;
  parts?: MsgPart[];
  files?: AttachedFile[];
}
