#!/usr/bin/env node
// Fast Apps — proxied-mode HTTP server bundling seven deterministic utility apps.
//
// Single Node process, zero external dependencies. Serves one OpenAPI 3.0
// spec per app at /openapi/<slug>.json plus a single operation POST per app.
// Every response is JSON and every handler completes in well under 500ms.
//
// Registered at boot by apps/server/src/index.ts via FLOOM_APPS_CONFIG ->
// examples/fast-apps/apps.yaml. Ingested as seven separate rows in the
// apps table, each with base_url = http://localhost:<PORT>.
//
// Apps bundled:
//   uuid        POST /uuid/run          random UUID v4 or v7
//   password    POST /password/run      secure random password
//   hash        POST /hash/run          md5, sha1, sha256, sha512 digests
//   base64      POST /base64/run        encode or decode
//   json-format POST /json-format/run   pretty print JSON with chosen indent
//   jwt-decode  POST /jwt-decode/run    decode header + payload, no verify
//   word-count  POST /word-count/run    words, chars, lines, reading time
//
// Run: node examples/fast-apps/server.mjs
// Env: FAST_APPS_PORT=4200 (default)

import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

const PORT = Number(process.env.FAST_APPS_PORT || 4200);
const HOST = process.env.FAST_APPS_HOST || '127.0.0.1';
const PUBLIC_BASE =
  process.env.FAST_APPS_PUBLIC_BASE || `http://${HOST}:${PORT}`;

// ---------- shared helpers ----------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

async function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_048_576) {
        reject(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid_json_body'));
      }
    });
    req.on('error', reject);
  });
}

// Minimal UUID v7: 48 bits unix-ms timestamp, version 7, variant RFC 4122,
// 62 bits random. Pure implementation because Node < 22 lacks randomUUID v7.
function uuidV7() {
  const ms = BigInt(Date.now());
  const rand = randomBytes(10);
  const bytes = Buffer.alloc(16);
  bytes[0] = Number((ms >> 40n) & 0xffn);
  bytes[1] = Number((ms >> 32n) & 0xffn);
  bytes[2] = Number((ms >> 24n) & 0xffn);
  bytes[3] = Number((ms >> 16n) & 0xffn);
  bytes[4] = Number((ms >> 8n) & 0xffn);
  bytes[5] = Number(ms & 0xffn);
  bytes[6] = (rand[0] & 0x0f) | 0x70;
  bytes[7] = rand[1];
  bytes[8] = (rand[2] & 0x3f) | 0x80;
  bytes[9] = rand[3];
  bytes[10] = rand[4];
  bytes[11] = rand[5];
  bytes[12] = rand[6];
  bytes[13] = rand[7];
  bytes[14] = rand[8];
  bytes[15] = rand[9];
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(
    12,
    16,
  )}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// base64url -> utf-8 JSON. Throws on invalid base64 or invalid JSON.
function decodeJwtSegment(segment) {
  let b64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const pad = b64.length % 4;
  if (pad === 2) b64 += '==';
  else if (pad === 3) b64 += '=';
  else if (pad !== 0) throw new Error('invalid_base64url');
  const json = Buffer.from(b64, 'base64').toString('utf-8');
  return JSON.parse(json);
}

// ---------- handlers ----------

function handleUuid(body) {
  const version = body.version === 'v7' ? 'v7' : 'v4';
  const countRaw = Number(body.count ?? 1);
  if (!Number.isFinite(countRaw) || countRaw < 1 || countRaw > 100) {
    throw httpError(400, 'count must be an integer between 1 and 100');
  }
  const count = Math.floor(countRaw);
  const uuids = [];
  for (let i = 0; i < count; i++) {
    uuids.push(version === 'v7' ? uuidV7() : randomUUID());
  }
  return { version, count, uuids };
}

const PASSWORD_ALPHABETS = {
  lower: 'abcdefghijklmnopqrstuvwxyz',
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  digits: '0123456789',
  symbols: "!@#$%^&*()-_=+[]{};:,.<>/?",
};

function handlePassword(body) {
  const length = Number(body.length ?? 20);
  if (!Number.isFinite(length) || length < 8 || length > 128) {
    throw httpError(400, 'length must be an integer between 8 and 128');
  }
  const useLower = body.lower !== false;
  const useUpper = body.upper !== false;
  const useDigits = body.digits !== false;
  const useSymbols = body.symbols === true;
  let alphabet = '';
  if (useLower) alphabet += PASSWORD_ALPHABETS.lower;
  if (useUpper) alphabet += PASSWORD_ALPHABETS.upper;
  if (useDigits) alphabet += PASSWORD_ALPHABETS.digits;
  if (useSymbols) alphabet += PASSWORD_ALPHABETS.symbols;
  if (alphabet.length === 0) {
    throw httpError(400, 'at least one of lower/upper/digits/symbols must be enabled');
  }
  // Rejection-sampled random to avoid modulo bias.
  const max = Math.floor(256 / alphabet.length) * alphabet.length;
  const out = [];
  while (out.length < length) {
    const buf = randomBytes(length * 2);
    for (let i = 0; i < buf.length && out.length < length; i++) {
      if (buf[i] < max) out.push(alphabet[buf[i] % alphabet.length]);
    }
  }
  const password = out.join('');
  // Approximate entropy: log2(alphabet) * length. Rounded to one decimal.
  const entropy =
    Math.round((Math.log2(alphabet.length) * length) * 10) / 10;
  return { password, length, alphabet_size: alphabet.length, entropy_bits: entropy };
}

const HASH_ALGOS = new Set(['md5', 'sha1', 'sha256', 'sha512']);

function handleHash(body) {
  if (typeof body.text !== 'string') {
    throw httpError(400, 'text must be a string');
  }
  const algo = (body.algorithm || 'sha256').toLowerCase();
  if (!HASH_ALGOS.has(algo)) {
    throw httpError(
      400,
      `algorithm must be one of: ${Array.from(HASH_ALGOS).join(', ')}`,
    );
  }
  const hex = createHash(algo).update(body.text, 'utf-8').digest('hex');
  return {
    algorithm: algo,
    input_length: body.text.length,
    digest_hex: hex,
    digest_length: hex.length,
  };
}

function handleBase64(body) {
  if (typeof body.text !== 'string') {
    throw httpError(400, 'text must be a string');
  }
  const mode = body.mode === 'decode' ? 'decode' : 'encode';
  const urlSafe = body.url_safe === true;
  if (mode === 'encode') {
    let out = Buffer.from(body.text, 'utf-8').toString('base64');
    if (urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return { mode, url_safe: urlSafe, result: out, result_length: out.length };
  }
  // decode
  let input = body.text;
  if (urlSafe) {
    input = input.replace(/-/g, '+').replace(/_/g, '/');
    const pad = input.length % 4;
    if (pad === 2) input += '==';
    else if (pad === 3) input += '=';
  }
  try {
    const buf = Buffer.from(input, 'base64');
    // Buffer.from is lenient; verify round-trip to catch garbage input.
    const roundTrip = buf.toString('base64');
    if (!urlSafe && roundTrip.replace(/=+$/, '') !== input.replace(/=+$/, '')) {
      throw httpError(400, 'input is not valid base64');
    }
    return {
      mode,
      url_safe: urlSafe,
      result: buf.toString('utf-8'),
      result_length: buf.length,
    };
  } catch (err) {
    if (err.statusCode) throw err;
    throw httpError(400, 'could not decode base64 input');
  }
}

function handleJsonFormat(body) {
  if (typeof body.text !== 'string') {
    throw httpError(400, 'text must be a string');
  }
  const indent = Number(body.indent ?? 2);
  if (!Number.isInteger(indent) || indent < 0 || indent > 8) {
    throw httpError(400, 'indent must be an integer between 0 and 8');
  }
  const sort = body.sort_keys === true;
  let parsed;
  try {
    parsed = JSON.parse(body.text);
  } catch (err) {
    throw httpError(400, `input is not valid JSON: ${err.message}`);
  }
  const formatted = sort
    ? JSON.stringify(sortKeys(parsed), null, indent)
    : JSON.stringify(parsed, null, indent);
  const minified = JSON.stringify(parsed);
  return {
    formatted,
    minified,
    indent,
    sorted_keys: sort,
    input_bytes: Buffer.byteLength(body.text, 'utf-8'),
    formatted_bytes: Buffer.byteLength(formatted, 'utf-8'),
  };
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function handleJwtDecode(body) {
  if (typeof body.token !== 'string' || !body.token.trim()) {
    throw httpError(400, 'token must be a non-empty string');
  }
  const parts = body.token.trim().split('.');
  if (parts.length !== 3) {
    throw httpError(400, 'token must have three dot-separated segments');
  }
  let header;
  let payload;
  try {
    header = decodeJwtSegment(parts[0]);
  } catch (err) {
    throw httpError(400, `header is not valid base64url JSON: ${err.message}`);
  }
  try {
    payload = decodeJwtSegment(parts[1]);
  } catch (err) {
    throw httpError(400, `payload is not valid base64url JSON: ${err.message}`);
  }
  const now = Math.floor(Date.now() / 1000);
  let expires_in_seconds = null;
  let expired = null;
  if (typeof payload.exp === 'number') {
    expires_in_seconds = payload.exp - now;
    expired = payload.exp < now;
  }
  let issued_ago_seconds = null;
  if (typeof payload.iat === 'number') {
    issued_ago_seconds = now - payload.iat;
  }
  return {
    header,
    payload,
    signature: parts[2],
    algorithm: typeof header.alg === 'string' ? header.alg : null,
    expires_in_seconds,
    expired,
    issued_ago_seconds,
    verified: false,
    note: 'Signature is not verified. Use for inspection only.',
  };
}

function handleWordCount(body) {
  if (typeof body.text !== 'string') {
    throw httpError(400, 'text must be a string');
  }
  const text = body.text;
  const chars = text.length;
  const charsNoSpaces = text.replace(/\s/g, '').length;
  const words = text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length;
  const lines = text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length;
  const sentences = text.trim().length === 0
    ? 0
    : (text.match(/[^.!?]+[.!?]+(\s|$)/g) || [text.trim()]).length;
  const paragraphs = text.trim().length === 0
    ? 0
    : text.split(/\n\s*\n/).filter((p) => p.trim().length > 0).length;
  // Reading time at 220 words per minute, rounded up to nearest minute.
  const reading_time_minutes = Math.max(1, Math.ceil(words / 220));
  return {
    words,
    chars,
    chars_no_spaces: charsNoSpaces,
    lines,
    sentences,
    paragraphs,
    reading_time_minutes,
  };
}

// ---------- OpenAPI specs ----------

function buildSpec(slug, title, description, operationId, requestSchema, responseSchema, exampleInput) {
  return {
    openapi: '3.0.0',
    info: { title, version: '1.0.0', description },
    servers: [{ url: PUBLIC_BASE }],
    paths: {
      [`/${slug}/run`]: {
        post: {
          operationId,
          summary: title,
          description,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: requestSchema,
                example: exampleInput,
              },
            },
          },
          responses: {
            200: {
              description: 'Success',
              content: {
                'application/json': { schema: responseSchema },
              },
            },
            400: {
              description: 'Invalid input',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      error: { type: 'string' },
                      code: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

const SPECS = {
  uuid: buildSpec(
    'uuid',
    'UUID Generator',
    'Generate one or more UUID v4 or v7 strings. Pure random v4 or time-ordered v7.',
    'generate',
    {
      type: 'object',
      properties: {
        version: {
          type: 'string',
          enum: ['v4', 'v7'],
          default: 'v4',
          description: 'UUID version. v4 is pure random, v7 encodes a sortable timestamp.',
        },
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          default: 1,
          description: 'How many UUIDs to return (1 to 100).',
        },
      },
    },
    {
      type: 'object',
      properties: {
        version: { type: 'string' },
        count: { type: 'integer' },
        uuids: { type: 'array', items: { type: 'string' } },
      },
    },
    { version: 'v4', count: 3 },
  ),
  password: buildSpec(
    'password',
    'Password Generator',
    'Generate a cryptographically secure random password using crypto.randomBytes. Rejection-sampled to avoid modulo bias.',
    'generate',
    {
      type: 'object',
      properties: {
        length: {
          type: 'integer',
          minimum: 8,
          maximum: 128,
          default: 20,
          description: 'Password length in characters (8 to 128).',
        },
        lower: { type: 'boolean', default: true, description: 'Include lowercase letters.' },
        upper: { type: 'boolean', default: true, description: 'Include uppercase letters.' },
        digits: { type: 'boolean', default: true, description: 'Include digits.' },
        symbols: { type: 'boolean', default: false, description: 'Include punctuation symbols.' },
      },
    },
    {
      type: 'object',
      properties: {
        password: { type: 'string' },
        length: { type: 'integer' },
        alphabet_size: { type: 'integer' },
        entropy_bits: { type: 'number' },
      },
    },
    { length: 24, lower: true, upper: true, digits: true, symbols: true },
  ),
  hash: buildSpec(
    'hash',
    'Hash',
    'Compute an md5, sha1, sha256, or sha512 digest of UTF-8 text and return the hex representation.',
    'hash',
    {
      type: 'object',
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: 'Text to hash. Treated as UTF-8.',
        },
        algorithm: {
          type: 'string',
          enum: ['md5', 'sha1', 'sha256', 'sha512'],
          default: 'sha256',
        },
      },
    },
    {
      type: 'object',
      properties: {
        algorithm: { type: 'string' },
        input_length: { type: 'integer' },
        digest_hex: { type: 'string' },
        digest_length: { type: 'integer' },
      },
    },
    { text: 'hello world', algorithm: 'sha256' },
  ),
  base64: buildSpec(
    'base64',
    'Base64',
    'Encode UTF-8 text to base64, or decode base64 back to UTF-8. Supports URL-safe variant.',
    'convert',
    {
      type: 'object',
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: 'The text to encode or the base64 string to decode.',
        },
        mode: {
          type: 'string',
          enum: ['encode', 'decode'],
          default: 'encode',
        },
        url_safe: {
          type: 'boolean',
          default: false,
          description: 'Use the URL-safe alphabet (- and _) with no padding.',
        },
      },
    },
    {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        url_safe: { type: 'boolean' },
        result: { type: 'string' },
        result_length: { type: 'integer' },
      },
    },
    { text: 'hello world', mode: 'encode' },
  ),
  'json-format': buildSpec(
    'json-format',
    'JSON Formatter',
    'Parse a JSON string and return a pretty-printed version with configurable indent. Also returns the minified form.',
    'format',
    {
      type: 'object',
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: 'The JSON text to parse and format.',
        },
        indent: {
          type: 'integer',
          minimum: 0,
          maximum: 8,
          default: 2,
          description: 'Number of spaces to indent each level.',
        },
        sort_keys: {
          type: 'boolean',
          default: false,
          description: 'Recursively sort object keys alphabetically.',
        },
      },
    },
    {
      type: 'object',
      properties: {
        formatted: { type: 'string' },
        minified: { type: 'string' },
        indent: { type: 'integer' },
        sorted_keys: { type: 'boolean' },
        input_bytes: { type: 'integer' },
        formatted_bytes: { type: 'integer' },
      },
    },
    { text: '{"name":"floom","apps":15,"ok":true}', indent: 2 },
  ),
  'jwt-decode': buildSpec(
    'jwt-decode',
    'JWT Decoder',
    'Decode a JWT header and payload without verifying the signature. Useful for inspecting claims, expiry, and algorithm during debugging.',
    'decode',
    {
      type: 'object',
      required: ['token'],
      properties: {
        token: {
          type: 'string',
          description: 'The JWT (three dot-separated base64url segments).',
        },
      },
    },
    {
      type: 'object',
      properties: {
        header: { type: 'object' },
        payload: { type: 'object' },
        signature: { type: 'string' },
        algorithm: { type: 'string' },
        expires_in_seconds: { type: 'integer' },
        expired: { type: 'boolean' },
        issued_ago_seconds: { type: 'integer' },
        verified: { type: 'boolean' },
        note: { type: 'string' },
      },
    },
    {
      token:
        'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkZsb29tIERlbW8iLCJpYXQiOjE1MTYyMzkwMjJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
    },
  ),
  'word-count': buildSpec(
    'word-count',
    'Word Count',
    'Count words, characters, lines, sentences, and paragraphs in a block of text. Estimates reading time at 220 words per minute.',
    'count',
    {
      type: 'object',
      required: ['text'],
      properties: {
        text: {
          type: 'string',
          description: 'The text to analyze.',
        },
      },
    },
    {
      type: 'object',
      properties: {
        words: { type: 'integer' },
        chars: { type: 'integer' },
        chars_no_spaces: { type: 'integer' },
        lines: { type: 'integer' },
        sentences: { type: 'integer' },
        paragraphs: { type: 'integer' },
        reading_time_minutes: { type: 'integer' },
      },
    },
    {
      text: 'Floom runs real apps as HTTP, MCP, CLI, and web forms from a single manifest.',
    },
  ),
};

// ---------- routing table ----------

const HANDLERS = {
  uuid: handleUuid,
  password: handlePassword,
  hash: handleHash,
  base64: handleBase64,
  'json-format': handleJsonFormat,
  'jwt-decode': handleJwtDecode,
  'word-count': handleWordCount,
};

function httpError(status, message, code) {
  const err = new Error(message);
  err.statusCode = status;
  err.code = code || 'bad_request';
  return err;
}

// ---------- HTTP server ----------

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', PUBLIC_BASE);
    const pathname = url.pathname;

    // Health probe.
    if (req.method === 'GET' && pathname === '/health') {
      return sendJson(res, 200, {
        ok: true,
        service: 'fast-apps',
        apps: Object.keys(SPECS),
      });
    }

    // OpenAPI spec per slug.
    if (req.method === 'GET' && pathname.startsWith('/openapi/')) {
      const slug = pathname.slice('/openapi/'.length).replace(/\.json$/, '');
      const spec = SPECS[slug];
      if (!spec) {
        return sendJson(res, 404, { error: 'unknown_app', slug });
      }
      return sendJson(res, 200, spec);
    }

    // Per-app run endpoint.
    const match = pathname.match(/^\/([a-z0-9-]+)\/run$/);
    if (req.method === 'POST' && match) {
      const slug = match[1];
      const handler = HANDLERS[slug];
      if (!handler) {
        return sendJson(res, 404, { error: 'unknown_app', slug });
      }
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return sendJson(res, 400, {
          error: err.message || 'invalid_body',
          code: 'invalid_body',
        });
      }
      try {
        const result = handler(body);
        return sendJson(res, 200, result);
      } catch (err) {
        if (err.statusCode) {
          return sendJson(res, err.statusCode, {
            error: err.message,
            code: err.code || 'bad_request',
          });
        }
        console.error(`[fast-apps] ${slug} handler crashed:`, err);
        return sendJson(res, 500, {
          error: 'internal_error',
          code: 'internal_error',
        });
      }
    }

    sendJson(res, 404, { error: 'not_found', path: pathname });
  } catch (err) {
    console.error('[fast-apps] request failed:', err);
    sendJson(res, 500, { error: 'internal_error' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[fast-apps] listening on ${PUBLIC_BASE}`);
  console.log(`[fast-apps] apps: ${Object.keys(SPECS).join(', ')}`);
});

// Clean shutdown so parent process can stop us without orphans.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
