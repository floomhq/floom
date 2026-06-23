/**
 * Regenerate the /integrations catalog from the Composio v3 /toolkits API.
 *
 * Usage:
 *   KEY=$(grep -oE 'COMPOSIO_API_KEY=.*' /root/.config/floom-secrets/composio.env | head -1 | cut -d= -f2 | tr -d '"')
 *   COMPOSIO_API_KEY=$KEY node app/\(home\)/integrations/generate-catalog.mjs
 *
 * Writes two files so the page can stay light:
 *   - catalog.json        slim list for the grid + search + filters
 *                         ({ slug, name, logo, categories, blurb })
 *   - catalog-detail.json full per-tool detail keyed by slug, lazy-loaded on
 *                         demand ({ description, toolsCount, triggersCount,
 *                         auth, appUrl })
 *
 * Paginate: fetches limit=1000, then follows next_cursor until exhausted.
 * All data comes from the API — nothing is invented.
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
const BLURB_MAX = 110; // card description budget; full text lives in the detail file

async function fetchPage(cursor) {
  const url = cursor
    ? `${BASE}?limit=${LIMIT}&cursor=${encodeURIComponent(cursor)}`
    : `${BASE}?limit=${LIMIT}`;
  const res = await fetch(url, { headers: { "x-api-key": API_KEY } });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

/* Trim to a word boundary near the budget, append an ellipsis when cut. */
function blurbOf(description) {
  const d = description.trim();
  if (d.length <= BLURB_MAX) return d;
  const cut = d.slice(0, BLURB_MAX);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > 60 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/* Only keep http(s) product links; anything else (javascript:, data:, …) is dropped. */
function safeUrl(raw) {
  if (!raw) return "";
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? raw : "";
  } catch {
    return "";
  }
}

const list = [];
const detail = {};
const seen = new Set();
let cursor = null;

do {
  const data = await fetchPage(cursor);
  for (const item of data.items ?? []) {
    const slug = item.slug ?? "";
    if (!slug) throw new Error(`Toolkit with empty slug: ${JSON.stringify(item.name)}`);
    if (seen.has(slug)) throw new Error(`Duplicate slug in catalog: ${slug}`);
    seen.add(slug);

    const meta = item.meta ?? {};
    const description = (meta.description ?? "").trim();
    const categories = (meta.categories ?? []).map((c) => c?.name).filter(Boolean);

    list.push({ slug, name: item.name ?? "", logo: meta.logo ?? "", categories, blurb: blurbOf(description) });
    detail[slug] = {
      description,
      toolsCount: meta.tools_count ?? 0,
      triggersCount: meta.triggers_count ?? 0,
      // Primary auth scheme (OAUTH2 / API_KEY / NO_AUTH / ...).
      auth: (item.auth_schemes ?? [])[0] ?? (item.no_auth ? "NO_AUTH" : ""),
      appUrl: safeUrl(meta.app_url ?? ""),
    };
  }
  cursor = data.next_cursor ?? null;
  console.log(`Fetched ${list.length} so far (cursor: ${cursor ?? "done"})`);
} while (cursor);

// Sort the list by display name, case-insensitive (detail is keyed, order-free).
list.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

const __dir = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(__dir, "catalog.json"), JSON.stringify(list, null, 2));
writeFileSync(join(__dir, "catalog-detail.json"), JSON.stringify(detail, null, 2));
console.log(`Wrote ${list.length} list entries + ${Object.keys(detail).length} detail records`);
