// Round-09 P0 #2 — deterministic "Hire a worker" create intent.
//
// The create-mode hero ("Hire a worker") promises Emily will DRAFT a worker,
// but it rode the generic /chat path with no create signal, so whether a worker
// got drafted depended on the LLM's tool choice — and live it answered with a
// LIST of existing workers instead. This wraps the user's plain-English job
// description in an explicit worker-authoring directive so the backend reliably
// routes it to the worker-drafting path.
//
// `WORKER_AUTHORING_INTENT_RE` mirrors the engine's `_WORKER_AUTHORING_INTENT_RE`
// (engine apps/api/chat_service.py): the backend uses it to decide whether to
// inject the worker-authoring rules into Emily's system prompt. The wrapped
// message MUST trip this regex so the authoring rules load every time, not just
// when the user happens to phrase the prompt with create/build/draft + worker.
//
// NOTE (engine-sync): EmilyChat.tsx is engine-synced. Keep this create-intent
// wiring aligned with the backend worker-authoring intent detector.
// Uses [\s\S] (not `.` with the `s`/dotAll flag) so it matches across newlines
// while staying compatible with the project's pre-es2018 TS target. Mirrors the
// engine's re.DOTALL semantics for the `.{0,90}` gaps.
export const WORKER_AUTHORING_INTENT_RE =
  /(\b(create|build|make|draft|author|generate|write|scaffold|clone|fork)\b[\s\S]{0,90}\b(worker|agent|automation|worker\.ya?ml)\b|\b(worker|agent|automation|worker\.ya?ml)\b[\s\S]{0,90}\b(create|build|make|draft|author|generate|write|edit|update|modify|fix|clone|fork)\b|\b(edit|update|modify|fix)\b[\s\S]{0,90}\bworker\b|\bworkers__(create|create_from_prompt|update)\b|\bworker\.ya?ml\b)/i;

// Stable marker so we can detect (and never double-wrap) an already-wrapped
// directive — the hero submit fires once, but guarding keeps it idempotent.
export const CREATE_WORKER_DIRECTIVE_MARKER = "[create-worker]";

const DIRECTIVE_HEAD =
  `${CREATE_WORKER_DIRECTIVE_MARKER} Create a new worker for this job. ` +
  "Draft the worker (pick the right integrations), create it, and open the editor " +
  "so I can review before running. Do not just list or describe existing workers.";

/**
 * Wrap a plain-English job description into an explicit worker-authoring
 * directive. Idempotent: a message that already carries the directive marker is
 * returned unchanged.
 */
export function buildCreateWorkerMessage(prompt: string): string {
  const text = prompt.trim();
  if (!text) return text;
  if (text.includes(CREATE_WORKER_DIRECTIVE_MARKER)) return text;
  return `${DIRECTIVE_HEAD}\n\nJob description:\n${text}`;
}
