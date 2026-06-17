import { toast } from "sonner";

// #1446: surface a background load/action failure instead of swallowing it.
// Logs for ops/debugging and shows a user-facing toast. The engine has zero
// telemetry, so this is console + toast only (no analytics).
export function reportError(message: string, err: unknown): void {
  console.error(message, err);
  toast.error(message);
}

// For repeated/polling fetches where a toast on every tick would spam: log
// only, no toast.
export function logError(message: string, err: unknown): void {
  console.error(message, err);
}
