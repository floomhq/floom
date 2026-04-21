// Smart-feedback: thin fetch-based Gemini client.
//
// We intentionally do NOT pull in `@google/generative-ai` for this feature —
// the dependency surface is small, the parser does one call in one place, and
// keeping it fetch-only matches services/parser.ts (OpenAI) which is also a
// thin wrapper. If a future caller needs streaming or function calling,
// switch to the SDK then.
//
// Public contract: `parseFeedbackWithGemini(text)` returns a clean
// `{ title, description, bucket }` triple suitable for filing as a GitHub
// issue. The function is resilient — when GEMINI_API_KEY is unset, the
// upstream call fails, the response shape is wrong, or the JSON is
// malformed, we fall back to a trivial identity mapping so the feedback
// submit path NEVER blocks on the parser being available.

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
// Flash is fast + cheap + plenty accurate for triage classification. We
// pin the minor version so model drift on `-latest` can't silently break
// the JSON shape contract.
const GEMINI_MODEL = process.env.FEEDBACK_GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_TIMEOUT_MS = 30_000;

export type FeedbackBucket = 'bug' | 'feature' | 'question' | 'feedback';
export const FEEDBACK_BUCKETS: readonly FeedbackBucket[] = [
  'bug',
  'feature',
  'question',
  'feedback',
];

export interface ParsedFeedback {
  title: string;
  description: string;
  bucket: FeedbackBucket;
}

const SYSTEM_PROMPT = `You are a triage assistant. Convert the user's raw feedback into a clean GitHub issue. Return JSON with: title (max 80 chars, imperative tense), description (user's text cleaned up, no preamble), bucket (one of: bug, feature, question, feedback). Do not invent facts. If the paste is unclear, leave description as the original and pick bucket=feedback.`;

/**
 * Deterministic fallback: enforce the shape contract when the LLM is
 * unavailable or returned garbage. Keeps the call site free of
 * conditional branches.
 */
function fallback(text: string): ParsedFeedback {
  const trimmed = text.trim();
  return {
    title: trimmed.slice(0, 80) || 'Feedback',
    description: trimmed,
    bucket: 'feedback',
  };
}

function clampTitle(raw: unknown, sourceText: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    return sourceText.trim().slice(0, 80) || 'Feedback';
  }
  return raw.trim().slice(0, 80);
}

function coerceBucket(raw: unknown): FeedbackBucket {
  if (typeof raw === 'string') {
    const lc = raw.toLowerCase().trim() as FeedbackBucket;
    if ((FEEDBACK_BUCKETS as readonly string[]).includes(lc)) return lc;
  }
  return 'feedback';
}

/**
 * Parse a raw feedback paste into a structured GitHub-issue triple.
 *
 * Never throws for upstream failures — falls back to
 * `{ title: text.slice(0,80), description: text, bucket: 'feedback' }`
 * so the submit path stays a single linear flow.
 */
export async function parseFeedbackWithGemini(text: string): Promise<ParsedFeedback> {
  const trimmed = text.trim();
  if (!trimmed) {
    return fallback(text);
  }
  if (!GEMINI_API_KEY) {
    return fallback(text);
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);

  try {
    // Google's Gemini v1beta REST surface. We use `generateContent` with
    // `responseMimeType=application/json` so the model returns raw JSON
    // text instead of a markdown-wrapped code block; this removes the
    // strip-backticks step the OpenAI parser has to do.
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(GEMINI_MODEL)}:generateContent` +
      `?key=${encodeURIComponent(GEMINI_API_KEY)}`;

    const res = await fetch(url, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: {
          role: 'system',
          parts: [{ text: SYSTEM_PROMPT }],
        },
        contents: [
          {
            role: 'user',
            parts: [{ text: trimmed }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          responseMimeType: 'application/json',
        },
      }),
    });

    if (!res.ok) {
      return fallback(text);
    }

    type GeminiResponse = {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
    };
    const body = (await res.json()) as GeminiResponse;
    const raw = body?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (typeof raw !== 'string' || !raw.trim()) {
      return fallback(text);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fallback(text);
    }
    if (!parsed || typeof parsed !== 'object') {
      return fallback(text);
    }
    const p = parsed as Record<string, unknown>;
    const description =
      typeof p.description === 'string' && p.description.trim()
        ? p.description.trim()
        : trimmed;

    return {
      title: clampTitle(p.title, trimmed),
      description,
      bucket: coerceBucket(p.bucket),
    };
  } catch {
    return fallback(text);
  } finally {
    clearTimeout(timer);
  }
}
