// Tiny fetch wrapper around the Floom backend API.
import type {
  HubApp,
  AppDetail,
  PickResult,
  ParseResult,
  RunRecord,
} from '../lib/types';

const API_BASE = '';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  return (await res.json()) as T;
}

export function getHub(): Promise<HubApp[]> {
  return request<HubApp[]>('/api/hub');
}

export function getApp(slug: string): Promise<AppDetail> {
  return request<AppDetail>(`/api/hub/${slug}`);
}

export function pickApps(prompt: string, limit = 3): Promise<{ apps: PickResult[] }> {
  return request('/api/pick', {
    method: 'POST',
    body: JSON.stringify({ prompt, limit }),
  });
}

export function parsePrompt(
  prompt: string,
  appSlug: string,
  action?: string,
): Promise<ParseResult> {
  return request('/api/parse', {
    method: 'POST',
    body: JSON.stringify({ prompt, app_slug: appSlug, action }),
  });
}

export function startRun(
  appSlug: string,
  inputs: Record<string, unknown>,
  threadId?: string,
  action?: string,
): Promise<{ run_id: string; status: string }> {
  return request('/api/run', {
    method: 'POST',
    body: JSON.stringify({ app_slug: appSlug, inputs, thread_id: threadId, action }),
  });
}

export function getRun(runId: string): Promise<RunRecord> {
  return request<RunRecord>(`/api/run/${runId}`);
}

export interface RunStreamHandlers {
  onLog?: (line: { stream: 'stdout' | 'stderr'; text: string; ts: number }) => void;
  onStatus?: (run: RunRecord) => void;
  onError?: (err: Error) => void;
}

/**
 * Open an SSE connection to /api/run/:id/stream. Returns a cleanup function.
 */
export function streamRun(runId: string, handlers: RunStreamHandlers): () => void {
  const es = new EventSource(`/api/run/${runId}/stream`);

  es.addEventListener('log', (evt) => {
    try {
      const data = JSON.parse((evt as MessageEvent).data);
      handlers.onLog?.(data);
    } catch {
      // ignore
    }
  });

  es.addEventListener('status', (evt) => {
    try {
      const data = JSON.parse((evt as MessageEvent).data);
      handlers.onStatus?.(data);
      if (['success', 'error', 'timeout'].includes(data.status)) {
        es.close();
      }
    } catch {
      // ignore
    }
  });

  es.onerror = () => {
    handlers.onError?.(new Error('Stream disconnected'));
    es.close();
  };

  return () => es.close();
}

export function createThread(): Promise<{ id: string }> {
  return request('/api/thread', { method: 'POST' });
}

export function saveTurn(
  threadId: string,
  kind: 'user' | 'assistant',
  payload: unknown,
): Promise<{ id: string; turn_index: number }> {
  return request(`/api/thread/${threadId}/turn`, {
    method: 'POST',
    body: JSON.stringify({ kind, payload }),
  });
}
