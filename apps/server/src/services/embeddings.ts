// Embeddings service. Used by the app picker.
// Falls back to keyword scoring when OPENAI_API_KEY is missing.
import { db } from '../db.js';
import type { AppRecord } from '../types.js';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EMBED_MODEL = process.env.EMBED_MODEL || 'text-embedding-3-small';

function cosine(a: Buffer, b: Buffer): number {
  const len = Math.min(a.length, b.length) >> 2;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < len; i++) {
    const av = a.readFloatLE(i * 4);
    const bv = b.readFloatLE(i * 4);
    dot += av * bv;
    na += av * av;
    nb += bv * bv;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function float32ToBuffer(vec: number[]): Buffer {
  const buf = Buffer.allocUnsafe(vec.length * 4);
  for (let i = 0; i < vec.length; i++) buf.writeFloatLE(vec[i], i * 4);
  return buf;
}

async function fetchEmbedding(text: string): Promise<number[]> {
  if (!OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY not set');
  }
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`OpenAI embeddings error ${res.status}: ${body}`);
  }
  const data = (await res.json()) as { data: Array<{ embedding: number[] }> };
  return data.data[0].embedding;
}

function appText(app: Pick<AppRecord, 'name' | 'description' | 'category'>): string {
  return [app.name, app.description, app.category].filter(Boolean).join(' — ');
}

/**
 * Upsert the embedding for an app. Silent no-op if OPENAI_API_KEY missing.
 */
export async function upsertAppEmbedding(appId: string, text: string): Promise<void> {
  if (!OPENAI_API_KEY) return;
  try {
    const vec = await fetchEmbedding(text);
    const buf = float32ToBuffer(vec);
    db.prepare(
      `INSERT INTO embeddings (app_id, text, vector) VALUES (?, ?, ?)
       ON CONFLICT(app_id) DO UPDATE SET text = excluded.text, vector = excluded.vector, updated_at = datetime('now')`,
    ).run(appId, text, buf);
  } catch (err) {
    console.error('[embeddings] upsert failed:', err);
  }
}

/**
 * Backfill embeddings for every app that doesn't have one yet.
 * Runs at boot after apps are seeded.
 */
export async function backfillAppEmbeddings(): Promise<void> {
  if (!OPENAI_API_KEY) {
    console.log('[embeddings] OPENAI_API_KEY missing — picker will use keyword fallback');
    return;
  }
  const apps = db
    .prepare(
      `SELECT a.id, a.name, a.description, a.category
       FROM apps a
       LEFT JOIN embeddings e ON e.app_id = a.id
       WHERE e.app_id IS NULL`,
    )
    .all() as Array<Pick<AppRecord, 'id' | 'name' | 'description' | 'category'>>;

  if (apps.length === 0) return;
  console.log(`[embeddings] backfilling ${apps.length} apps`);
  for (const app of apps) {
    await upsertAppEmbedding(app.id, appText(app));
  }
  console.log('[embeddings] backfill complete');
}

export interface PickResult {
  slug: string;
  name: string;
  description: string;
  category: string | null;
  icon: string | null;
  confidence: number;
}

/**
 * Search apps by natural-language query. Returns top N with confidence 0..1.
 * Vector search when OPENAI_API_KEY is set, keyword fallback otherwise.
 */
export async function pickApps(query: string, limit = 3): Promise<PickResult[]> {
  const allApps = db
    .prepare(
      "SELECT id, slug, name, description, category, icon FROM apps" +
        " WHERE status = 'active'" +
        " AND (visibility = 'public' OR visibility IS NULL)",
    )
    .all() as Array<
    Pick<AppRecord, 'id' | 'slug' | 'name' | 'description' | 'category' | 'icon'>
  >;

  if (allApps.length === 0) return [];

  let scored: Array<{ app: (typeof allApps)[number]; score: number }>;

  if (OPENAI_API_KEY) {
    try {
      const queryVec = await fetchEmbedding(query);
      const queryBuf = float32ToBuffer(queryVec);
      const embedRows = db
        .prepare('SELECT app_id, vector FROM embeddings')
        .all() as Array<{ app_id: string; vector: Buffer }>;
      const vecMap = new Map(embedRows.map((r) => [r.app_id, r.vector]));
      scored = allApps.map((app) => {
        const vec = vecMap.get(app.id);
        const score = vec ? cosine(queryBuf, vec) : 0;
        return { app, score };
      });
    } catch (err) {
      console.error('[picker] vector search failed, falling back to keyword:', err);
      scored = keywordScore(query, allApps);
    }
  } else {
    scored = keywordScore(query, allApps);
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => ({
      slug: r.app.slug,
      name: r.app.name,
      description: r.app.description,
      category: r.app.category,
      icon: r.app.icon,
      confidence: Math.max(0, Math.min(1, r.score)),
    }));
}

function keywordScore<T extends Pick<AppRecord, 'name' | 'description' | 'category'>>(
  query: string,
  apps: T[],
): Array<{ app: T; score: number }> {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return apps.map((app) => ({ app, score: 0 }));
  return apps.map((app) => {
    const haystack = [app.name, app.description, app.category]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    const hits = terms.filter((t) => haystack.includes(t)).length;
    return { app, score: hits / terms.length };
  });
}
