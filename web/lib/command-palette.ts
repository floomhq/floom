import type { WorkerSummary } from "@/lib/types";

function normalizeSearch(value: string): string {
  return value.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

function containsAllTokens(haystack: string, query: string): boolean {
  const tokens = normalizeSearch(query).split(" ").filter(Boolean);
  return tokens.length === 0 || tokens.every((token) => haystack.includes(token));
}

function workerSearchScore(worker: WorkerSummary, query: string): number {
  const q = normalizeSearch(query);
  if (!q) return 1;

  const name = normalizeSearch(worker.name);
  const id = normalizeSearch(worker.id);
  const description = normalizeSearch(worker.description ?? "");
  const combined = `${name} ${id} ${description}`;
  if (!containsAllTokens(combined, q)) return 0;

  if (name === q) return 1000;
  if (name.startsWith(q)) return 900;
  if (name.includes(q)) return 800;
  if (id === q) return 700;
  if (id.startsWith(q)) return 650;
  if (id.includes(q)) return 600;
  if (description.includes(q)) return 300;
  return 100;
}

export function rankWorkersForCommandPalette(
  workers: WorkerSummary[],
  query: string,
  limit = 12,
): WorkerSummary[] {
  if (!query.trim()) return workers.slice(0, limit);
  return workers
    .map((worker, index) => ({ worker, score: workerSearchScore(worker, query), index }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map((row) => row.worker);
}
