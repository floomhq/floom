// Shared JSON body parser for POST routes.
//
// Why this exists (2026-04-20, P2 #146): the old pattern was
//   const body = (await c.req.json().catch(() => ({}))) as {...};
// which conflates three different cases into a silent `{}`:
//
//   1. No body at all       — acceptable for zero-input actions (`curl -XPOST`)
//   2. Empty string body     — same, acceptable
//   3. Malformed / truncated — NOT acceptable; caller sent something broken
//      and should hear about it with a 400 so they can fix their client.
//
// parseJsonBody distinguishes (3) from (1)/(2) by sniffing the raw text
// before handing it to JSON.parse. If the body contains non-whitespace but
// fails to parse, we return an `error` kind so the route can 400 with
// { error, code: 'invalid_body', details }.
//
// Also enforces top-level shape: a JSON body must be an object. Arrays,
// primitives, and null all 400 because every route in this codebase
// destructures fields off the parsed value.
import type { Context } from 'hono';

export type ParsedBody =
  | { kind: 'ok'; value: Record<string, unknown> }
  | { kind: 'error'; reason: 'malformed_json' | 'wrong_shape'; raw?: string; parseMessage?: string };

export async function parseJsonBody(c: Context): Promise<ParsedBody> {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    // Body stream errored mid-read. Treat as malformed.
    return { kind: 'error', reason: 'malformed_json' };
  }

  // No body OR body is only whitespace → ergonomic empty-object fallback.
  // Keeps `curl -X POST /api/base64/run` working for actions with no
  // required inputs.
  if (raw.trim().length === 0) {
    return { kind: 'ok', value: {} };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return {
      kind: 'error',
      reason: 'malformed_json',
      raw,
      parseMessage: err instanceof Error ? err.message : String(err),
    };
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      kind: 'error',
      reason: 'wrong_shape',
      raw,
      parseMessage: 'Request body must be a JSON object',
    };
  }

  return { kind: 'ok', value: parsed as Record<string, unknown> };
}

/**
 * Build the 400 response for a ParsedBody error. Kept alongside parseJsonBody
 * so every caller returns the same { error, code, details } shape.
 */
export function bodyParseError(c: Context, err: Extract<ParsedBody, { kind: 'error' }>) {
  const message =
    err.reason === 'wrong_shape'
      ? 'Request body must be a JSON object'
      : 'Request body is not valid JSON';
  return c.json(
    {
      error: message,
      code: 'invalid_body',
      details: {
        reason: err.reason,
        parse_message: err.parseMessage ?? null,
      },
    },
    400,
  );
}
