/**
 * Client-side heuristic for fields that should never render as a plain
 * text input (OpenAPI apiKey / bearer-shaped params, OAuth client secrets,
 * etc.). Mirrors the spirit of `AUTH_PARAM_REGEX` and
 * `inputNameLooksLikeAuth` in apps/server/src/services/openapi-ingest.ts,
 * with a few extra substring checks so security-scheme names like
 * `ApiKeyAuth` still mask if they appear as an input name.
 *
 * False positives only tighten UX (masked field); false negatives leak secrets.
 */
const AUTH_PARAM_ANCHORED =
  /^(api[-_]?key|apikey|wskey|access[-_]?token|auth[-_]?token|bearer|x-api-key)$/i;

export function credentialInputNameLooksSensitive(rawName: string): boolean {
  if (!rawName) return false;
  if (/password|secret|credential/i.test(rawName)) return true;
  const name = rawName.replace(/^(header|cookie)_/i, '');
  const lower = name.toLowerCase();

  if (AUTH_PARAM_ANCHORED.test(name)) return true;
  if (/client[-_]?secret|clientsecret/i.test(lower)) return true;

  if (lower.includes('apikey')) return true;
  if (/(^|[-_])api[-_]?key($|[-_])/i.test(name)) return true;

  if (lower.includes('token')) {
    if (lower.includes('access') || lower.includes('auth')) return true;
  }

  return false;
}
