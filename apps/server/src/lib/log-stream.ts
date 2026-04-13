// In-memory pub/sub for streaming container stdout/stderr to SSE clients.
// One stream per runId. Subscribers receive replayed history + live events.

type LogLine = { stream: 'stdout' | 'stderr'; text: string; ts: number };
type Listener = (line: LogLine) => void;

interface LogStreamState {
  lines: LogLine[];
  listeners: Set<Listener>;
  done: boolean;
  finishListeners: Set<() => void>;
}

const streams = new Map<string, LogStreamState>();

export interface LogStreamHandle {
  append(text: string, stream: 'stdout' | 'stderr'): void;
  subscribe(fn: Listener, onFinish?: () => void): { history: LogLine[]; done: boolean; unsubscribe: () => void };
  finish(): void;
}

export function getOrCreateStream(runId: string): LogStreamHandle {
  let state = streams.get(runId);
  if (!state) {
    state = { lines: [], listeners: new Set(), done: false, finishListeners: new Set() };
    streams.set(runId, state);
  }
  const s = state;
  return {
    append(text: string, stream: 'stdout' | 'stderr') {
      if (s.done) return;
      const line: LogLine = { stream, text, ts: Date.now() };
      s.lines.push(line);
      for (const l of s.listeners) {
        try {
          l(line);
        } catch {
          // listeners must not crash the runner
        }
      }
    },
    subscribe(fn, onFinish) {
      s.listeners.add(fn);
      if (onFinish) s.finishListeners.add(onFinish);
      return {
        history: s.lines.slice(),
        done: s.done,
        unsubscribe: () => {
          s.listeners.delete(fn);
          if (onFinish) s.finishListeners.delete(onFinish);
        },
      };
    },
    finish() {
      if (s.done) return;
      s.done = true;
      for (const f of s.finishListeners) {
        try {
          f();
        } catch {
          // ignore
        }
      }
      // Free streams that no one is watching, after a grace period.
      setTimeout(() => {
        if (s.listeners.size === 0) streams.delete(runId);
      }, 60_000);
    },
  };
}

export function finishStream(runId: string): void {
  const s = streams.get(runId);
  if (s) getOrCreateStream(runId).finish();
}
