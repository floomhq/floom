/**
 * Reload-regression guard for the "3-vs-5 across reloads" class.
 *
 * Browser rendering of the live authed app is intentionally not used here.
 * The three main authed dashboard surfaces are backed by these API datasets:
 * /app/workers -> GET /workers?shape=list
 * /app/runs    -> GET /runs
 * /app/overview -> GET /system/overview
 *
 * Re-fetch each dataset several times and compare canonical ID sets. Counts and
 * ordering may update when real data changes, but back-to-back reads in one test
 * run must not randomly drop visible rows.
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { API, adminHeaders } from "./api.helpers";

const REFETCHES = 5;

type DatasetSample = {
  workers: string[];
  runs: string[];
  overviewRecentRuns: string[];
  overviewAttentionWorkers: string[];
};

function ids(rows: unknown, key = "id"): string[] {
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => (row && typeof row === "object" ? String((row as Record<string, unknown>)[key] ?? "") : ""))
    .filter(Boolean)
    .sort();
}

async function sample(request: APIRequestContext): Promise<DatasetSample> {
  const headers = adminHeaders();
  const [workersRes, runsRes, overviewRes] = await Promise.all([
    request.get(`${API}/workers?shape=list`, { headers }),
    request.get(`${API}/runs?limit=50`, { headers }),
    request.get(`${API}/system/overview`, { headers }),
  ]);
  expect(workersRes.status()).toBe(200);
  expect(runsRes.status()).toBe(200);
  expect(overviewRes.status()).toBe(200);

  const workers = await workersRes.json();
  const runs = await runsRes.json();
  const overview = await overviewRes.json();

  return {
    workers: ids(workers),
    runs: ids(runs),
    overviewRecentRuns: ids(overview?.recent_runs),
    overviewAttentionWorkers: ids(overview?.needs_attention, "worker_id"),
  };
}

test.describe("main authed route data reload stability", () => {
  test("workers, runs, and overview return identical datasets across rapid refetches", async ({ request }) => {
    const first = await sample(request);
    for (let i = 1; i < REFETCHES; i += 1) {
      expect(await sample(request)).toEqual(first);
    }
  });
});
