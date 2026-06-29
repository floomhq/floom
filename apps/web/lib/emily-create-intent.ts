// Historical create-intent detector kept for tests and old transcripts. Emily
// no longer drafts or creates workers from natural-language prompts, so create
// mode must not wrap user text in hidden worker-authoring directives.
export const WORKER_AUTHORING_INTENT_RE =
  /(\b(create|build|make|draft|author|generate|write|scaffold|clone|fork)\b[\s\S]{0,90}\b(worker|agent|automation|worker\.ya?ml)\b|\b(worker|agent|automation|worker\.ya?ml)\b[\s\S]{0,90}\b(create|build|make|draft|author|generate|write|edit|update|modify|fix|clone|fork)\b|\b(edit|update|modify|fix)\b[\s\S]{0,90}\bworker\b|\bworkers__(create|create_from_prompt|update)\b|\bworker\.ya?ml\b)/i;

// Stable marker so we can detect (and never double-wrap) an already-wrapped
// directive — the hero submit fires once, but guarding keeps it idempotent.
export const CREATE_WORKER_DIRECTIVE_MARKER = "[create-worker]";

/**
 * Legacy helper name retained so callers do not need a coordinated rename.
 * It intentionally returns the plain prompt: Emily should answer or guide the
 * user, not secretly start worker-authoring.
 */
export function buildCreateWorkerMessage(prompt: string): string {
  return prompt.trim();
}
