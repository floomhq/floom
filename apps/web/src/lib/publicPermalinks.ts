export type PermalinkLoadOutcome = 'not_found' | 'retryable';

export function buildPublicRunPath(runId: string): string {
  return `/r/${encodeURIComponent(runId)}`;
}

export function classifyPermalinkLoadError(error: unknown): PermalinkLoadOutcome {
  const status = readStatus(error);
  return status === 404 ? 'not_found' : 'retryable';
}

export function getPermalinkLoadErrorMessage(target: 'app' | 'run'): string {
  if (target === 'run') {
    return "We couldn't open this shared run right now. Check your connection and try again.";
  }
  return "We couldn't load this app right now. Check your connection and try again.";
}

export function getRunStartErrorMessage(
  error: unknown,
  fallback = 'Run failed to start',
): string {
  const status = readStatus(error);
  const message = readMessage(error);
  if (status === 429 || message.toLowerCase().includes('rate_limit_exceeded')) {
    return "You've hit the current run limit. Wait a minute, then try again.";
  }
  // Launch blocker fix (2026-04-20): the server returns "App is inactive,
  // cannot run" for seed apps whose docker image is missing on this host.
  // Echoing that raw message to the user reads as a permission problem
  // ("is the app turned off?") when really the creator just hasn't
  // published a runnable image. Translate to neutral copy that matches
  // the post-run `app_unavailable` class.
  if (/app is inactive|app_inactive/i.test(message)) {
    return "This app isn't available right now. The creator needs to fix or republish it. Try another app in the meantime.";
  }
  return message || fallback;
}

export function isTerminalRunStatus(status: string | null | undefined): boolean {
  return status === 'success' || status === 'error' || status === 'timeout';
}

function readStatus(error: unknown): number | null {
  if (!error || typeof error !== 'object' || !('status' in error)) return null;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' ? status : null;
}

function readMessage(error: unknown): string {
  if (!error || typeof error !== 'object' || !('message' in error)) return '';
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' ? message.trim() : '';
}
