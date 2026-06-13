/**
 * Regenerate catalog.json from Composio v3 /toolkits API.
 *
 * Usage:
 *   KEY=$(grep -oE 'COMPOSIO_API_KEY=.*' /root/.config/floom-secrets/composio.env | head -1 | cut -d= -f2 | tr -d '"')
 *   COMPOSIO_API_KEY=$KEY node app/\(home\)/integrations/generate-catalog.mjs
 *
 * Output: app/(home)/integrations/catalog.json
 * Paginate: fetches limit=1000, then follows next_cursor until exhausted.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API_KEY = process.env.COMPOSIO_API_KEY;
if (!API_KEY) {
  console.error("COMPOSIO_API_KEY env var is required");
  process.exit(1);
}

const BASE = "https://backend.composio.dev/api/v3/toolkits";
const LIMIT = 1000;

async function fetchPage(cursor) {
  const url = cursor
    ? `${BASE}?limit=${LIMIT}&cursor=${encodeURIComponent(cursor)}`
    : `${BASE}?limit=${LIMIT}`;
  const res = await fetch(url, {
    headers: { "x-api-key": API_KEY },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

const all = [];
let cursor = null;

do {
  const data = await fetchPage(cursor);
  const items = data.items ?? [];
  for (const item of items) {
    const logo = item.meta?.logo ?? "";
    all.push({ slug: item.slug ?? "", name: item.name ?? "", logo });
  }
  cursor = data.next_cursor ?? null;
  console.log(`Fetched ${all.length} so far (cursor: ${cursor ?? "done"})`);
} while (cursor);

// Sort by display name, case-insensitive
all.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

const __dir = dirname(fileURLToPath(import.meta.url));
const outPath = join(__dir, "catalog.json");
writeFileSync(outPath, JSON.stringify(all, null, 2));
console.log(`Wrote ${all.length} entries to ${outPath}`);
