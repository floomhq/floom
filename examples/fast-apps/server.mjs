#!/usr/bin/env node
// Fast Apps — proxied-mode HTTP server bundling deterministic utility apps.
//
// Single Node process, zero external dependencies. Serves one OpenAPI 3.0
// spec per app at /openapi/<slug>.json plus a single operation POST per app.
// Every response is JSON and every handler completes in well under 500ms.
//
// Registered at boot by apps/server/src/index.ts via FLOOM_APPS_CONFIG ->
// examples/fast-apps/apps.yaml. Ingested as separate rows in the
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
//   regex-test  POST /regex-test/run    regex matches, captures, indices
//   slugify     POST /slugify/run       URL-safe slugs
//   url-encode  POST /url-encode/run    encode or decode URL components
//   utm-builder POST /utm-builder/run   campaign URL builder
//   qr-code     POST /qr-code/run       QR code SVG + data URL
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

function handleRegexTest(body) {
  if (typeof body.pattern !== 'string' || body.pattern.length === 0) {
    throw httpError(400, 'pattern must be a non-empty string');
  }
  if (typeof body.text !== 'string') {
    throw httpError(400, 'text must be a string');
  }
  if (body.text.length > 100_000) {
    throw httpError(400, 'text must be at most 100000 characters');
  }
  const rawFlags = typeof body.flags === 'string' ? body.flags : '';
  if (!/^[gimsuy]*$/.test(rawFlags)) {
    throw httpError(400, 'flags must contain only g, i, m, s, u, or y');
  }
  const uniqueFlags = [...new Set(rawFlags.split(''))].join('');
  const scanFlags = uniqueFlags.includes('g') ? uniqueFlags : `${uniqueFlags}g`;
  let regex;
  try {
    regex = new RegExp(body.pattern, scanFlags);
  } catch (err) {
    return {
      is_valid: false,
      error: err.message,
      pattern: body.pattern,
      flags: uniqueFlags,
      match_count: 0,
      matches: [],
      truncated: false,
    };
  }

  const matches = [];
  let match;
  while ((match = regex.exec(body.text)) !== null) {
    const groups = match.slice(1).map((value) => value ?? null);
    matches.push({
      match: match[0],
      index: match.index,
      end_index: match.index + match[0].length,
      groups,
      named_groups: match.groups || {},
    });
    if (matches.length >= 100) break;
    if (match[0] === '') regex.lastIndex += 1;
  }

  return {
    is_valid: true,
    error: null,
    pattern: body.pattern,
    flags: uniqueFlags,
    match_count: matches.length,
    matches,
    truncated: matches.length >= 100,
  };
}

function handleSlugify(body) {
  if (typeof body.text !== 'string') {
    throw httpError(400, 'text must be a string');
  }
  const separator = body.separator == null ? '-' : String(body.separator);
  if (separator.length !== 1 || /[a-zA-Z0-9]/.test(separator)) {
    throw httpError(400, 'separator must be a single non-alphanumeric character');
  }
  const lowercase = body.lowercase !== false;
  let text = body.text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  if (lowercase) text = text.toLowerCase();
  const escaped = escapeRegExp(separator);
  let slug = text
    .replace(/[^a-zA-Z0-9]+/g, separator)
    .replace(new RegExp(`${escaped}{2,}`, 'g'), separator)
    .replace(new RegExp(`^${escaped}|${escaped}$`, 'g'), '');
  if (body.max_length != null && body.max_length !== '') {
    const max = Number(body.max_length);
    if (!Number.isInteger(max) || max < 1 || max > 200) {
      throw httpError(400, 'max_length must be an integer between 1 and 200');
    }
    slug = slug.slice(0, max).replace(new RegExp(`${escaped}+$`, 'g'), '');
  }
  return {
    slug,
    lowercase,
    separator,
    length: slug.length,
  };
}

function handleUrlEncode(body) {
  if (typeof body.text !== 'string') {
    throw httpError(400, 'text must be a string');
  }
  const mode = body.mode === 'decode' ? 'decode' : 'encode';
  const component = ['full', 'path-segment', 'query'].includes(body.component)
    ? body.component
    : 'full';
  const plusForSpace = body.plus_for_space === true;
  try {
    if (mode === 'encode') {
      let result = component === 'full' ? encodeURI(body.text) : encodeURIComponent(body.text);
      if (component === 'query' && plusForSpace) result = result.replace(/%20/g, '+');
      return { mode, component, result, length: result.length };
    }
    const input = component === 'query' ? body.text.replace(/\+/g, ' ') : body.text;
    const result = component === 'full' ? decodeURI(input) : decodeURIComponent(input);
    return { mode, component, result, length: result.length };
  } catch (err) {
    throw httpError(400, `could not ${mode} URL text: ${err.message}`);
  }
}

function handleUtmBuilder(body) {
  if (typeof body.base_url !== 'string' || body.base_url.trim().length === 0) {
    throw httpError(400, 'base_url must be a non-empty URL');
  }
  let url;
  try {
    url = new URL(body.base_url.trim());
  } catch {
    throw httpError(400, 'base_url must be an absolute URL');
  }
  const mapping = {
    source: 'utm_source',
    medium: 'utm_medium',
    campaign: 'utm_campaign',
    term: 'utm_term',
    content: 'utm_content',
    id: 'utm_id',
  };
  const utm = {};
  for (const [inputKey, param] of Object.entries(mapping)) {
    const value = body[inputKey];
    if (value == null || value === '') continue;
    if (typeof value !== 'string') {
      throw httpError(400, `${inputKey} must be a string`);
    }
    const trimmed = value.trim();
    if (!trimmed) continue;
    url.searchParams.set(param, trimmed);
    utm[param] = trimmed;
  }
  for (const required of ['utm_source', 'utm_medium', 'utm_campaign']) {
    if (!utm[required]) throw httpError(400, `${required.replace('utm_', '')} is required`);
  }
  return {
    url: url.toString(),
    query_string: url.search.replace(/^\?/, ''),
    utm,
  };
}

function handleQrCode(body) {
  if (typeof body.text !== 'string' || body.text.length === 0) {
    throw httpError(400, 'text must be a non-empty string');
  }
  const margin = Number(body.margin ?? 4);
  const scale = Number(body.scale ?? 8);
  if (!Number.isInteger(margin) || margin < 0 || margin > 16) {
    throw httpError(400, 'margin must be an integer between 0 and 16');
  }
  if (!Number.isInteger(scale) || scale < 2 || scale > 32) {
    throw httpError(400, 'scale must be an integer between 2 and 32');
  }
  const dark = typeof body.dark === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.dark)
    ? body.dark
    : '#111827';
  const light = typeof body.light === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.light)
    ? body.light
    : '#ffffff';
  const qr = makeQr(body.text);
  const svg = renderQrSvg(qr.modules, { margin, scale, dark, light });
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg, 'utf-8').toString('base64')}`;
  return {
    svg,
    data_url: dataUrl,
    text_length: Buffer.byteLength(body.text, 'utf-8'),
    version: qr.version,
    size: qr.modules.length,
    margin,
    scale,
    error_correction: 'L',
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Minimal QR Code Model 2 generator: byte mode, error correction level L,
// versions 1-5. This keeps the launch utility dependency-free while covering
// common URLs and short text snippets.
const QR_CAPACITY = {
  1: { data: 19, ecc: 7 },
  2: { data: 34, ecc: 10 },
  3: { data: 55, ecc: 15 },
  4: { data: 80, ecc: 20 },
  5: { data: 108, ecc: 26 },
};

function makeQr(text) {
  const data = [...Buffer.from(text, 'utf-8')];
  const version = Number(Object.keys(QR_CAPACITY).find((v) => data.length <= Math.floor((QR_CAPACITY[v].data * 8 - 12) / 8)));
  if (!version) {
    throw httpError(400, 'text is too long for QR Code Studio MVP; keep input under 106 UTF-8 bytes');
  }
  const { data: dataCodewords, ecc: eccCodewords } = QR_CAPACITY[version];
  const dataWords = encodeQrByteData(data, dataCodewords);
  const eccWords = reedSolomonRemainder(dataWords, eccCodewords);
  const codewords = [...dataWords, ...eccWords];
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const matrix = buildQrMatrix(version, codewords, mask);
    const penalty = qrPenalty(matrix.modules);
    if (!best || penalty < best.penalty) best = { ...matrix, penalty, mask };
  }
  return best;
}

function encodeQrByteData(bytes, dataCodewords) {
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);
  const capacityBits = dataCodewords * 8;
  appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);
  const words = [];
  for (let i = 0; i < bits.length; i += 8) {
    let value = 0;
    for (let j = 0; j < 8; j += 1) value = (value << 1) | bits[i + j];
    words.push(value);
  }
  for (let pad = 0; words.length < dataCodewords; pad += 1) {
    words.push(pad % 2 === 0 ? 0xec : 0x11);
  }
  return words;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
}

const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
}

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function reedSolomonGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]);
    }
    poly = next;
  }
  return poly;
}

function reedSolomonRemainder(data, degree) {
  const generator = reedSolomonGenerator(degree);
  const result = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) {
      result[i] ^= gfMul(generator[i + 1], factor);
    }
  }
  return result;
}

function buildQrMatrix(version, codewords, mask) {
  const size = 21 + 4 * (version - 1);
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFunction = (x, y, value) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = value;
    reserved[y][x] = true;
  };

  placeFinder(setFunction, 3, 3);
  placeFinder(setFunction, size - 4, 3);
  placeFinder(setFunction, 3, size - 4);
  for (let i = 0; i < size; i += 1) {
    setFunction(6, i, i % 2 === 0);
    setFunction(i, 6, i % 2 === 0);
  }
  if (version >= 2) {
    const p = size - 7;
    placeAlignment(setFunction, p, p);
  }
  setFunction(8, size - 8, true);
  reserveFormat(reserved);
  placeData(modules, reserved, codewords, mask);
  placeFormat(modules, reserved, mask);
  return { version, modules };
}

function placeFinder(setFunction, cx, cy) {
  for (let y = -4; y <= 4; y += 1) {
    for (let x = -4; x <= 4; x += 1) {
      const ax = Math.abs(x);
      const ay = Math.abs(y);
      const value = ax <= 3 && ay <= 3 && (ax === 3 || ay === 3 || (ax <= 1 && ay <= 1));
      setFunction(cx + x, cy + y, value);
    }
  }
}

function placeAlignment(setFunction, cx, cy) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const ax = Math.abs(x);
      const ay = Math.abs(y);
      setFunction(cx + x, cy + y, Math.max(ax, ay) !== 1);
    }
  }
}

function reserveFormat(reserved) {
  const size = reserved.length;
  for (let i = 0; i <= 8; i += 1) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
}

function placeData(modules, reserved, codewords, mask) {
  const size = modules.length;
  const bits = [];
  for (const word of codewords) appendBits(bits, word, 8);
  let bitIndex = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vert = 0; vert < size; vert += 1) {
      const y = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        if (reserved[y][x]) continue;
        const bit = bitIndex < bits.length ? bits[bitIndex] === 1 : false;
        modules[y][x] = bit !== maskApplies(mask, x, y);
        bitIndex += 1;
      }
    }
    upward = !upward;
  }
}

function maskApplies(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
    default: return false;
  }
}

function placeFormat(modules, reserved, mask) {
  const size = modules.length;
  const bits = formatBits(mask);
  const coords1 = [
    [8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8],
    [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8],
  ];
  const coords2 = [
    [size - 1, 8], [size - 2, 8], [size - 3, 8], [size - 4, 8], [size - 5, 8],
    [size - 6, 8], [size - 7, 8], [8, size - 8], [8, size - 7], [8, size - 6],
    [8, size - 5], [8, size - 4], [8, size - 3], [8, size - 2], [8, size - 1],
  ];
  for (let i = 0; i < 15; i += 1) {
    const bit = ((bits >>> i) & 1) === 1;
    for (const [x, y] of [coords1[i], coords2[i]]) {
      modules[y][x] = bit;
      reserved[y][x] = true;
    }
  }
}

function formatBits(mask) {
  const data = (0b01 << 3) | mask;
  let rem = data << 10;
  for (let i = 14; i >= 10; i -= 1) {
    if (((rem >>> i) & 1) !== 0) rem ^= 0x537 << (i - 10);
  }
  return ((data << 10) | rem) ^ 0x5412;
}

function qrPenalty(modules) {
  const size = modules.length;
  let penalty = 0;
  for (let y = 0; y < size; y += 1) penalty += linePenalty(modules[y]);
  for (let x = 0; x < size; x += 1) penalty += linePenalty(modules.map((row) => row[x]));
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = modules[y][x];
      if (modules[y][x + 1] === c && modules[y + 1][x] === c && modules[y + 1][x + 1] === c) {
        penalty += 3;
      }
    }
  }
  const finderPattern = '10111010000';
  const finderPatternRev = '00001011101';
  for (let y = 0; y < size; y += 1) {
    const row = modules[y].map((v) => (v ? '1' : '0')).join('');
    penalty += countPattern(row, finderPattern) * 40 + countPattern(row, finderPatternRev) * 40;
  }
  for (let x = 0; x < size; x += 1) {
    const col = modules.map((row) => (row[x] ? '1' : '0')).join('');
    penalty += countPattern(col, finderPattern) * 40 + countPattern(col, finderPatternRev) * 40;
  }
  const dark = modules.flat().filter(Boolean).length;
  const percent = (dark * 100) / (size * size);
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return penalty;
}

function linePenalty(line) {
  let penalty = 0;
  let runColor = line[0];
  let runLength = 1;
  for (let i = 1; i <= line.length; i += 1) {
    if (i < line.length && line[i] === runColor) {
      runLength += 1;
    } else {
      if (runLength >= 5) penalty += 3 + (runLength - 5);
      runColor = line[i];
      runLength = 1;
    }
  }
  return penalty;
}

function countPattern(text, pattern) {
  let count = 0;
  for (let i = 0; i <= text.length - pattern.length; i += 1) {
    if (text.slice(i, i + pattern.length) === pattern) count += 1;
  }
  return count;
}

function renderQrSvg(modules, opts) {
  const quietSize = modules.length + opts.margin * 2;
  const pixelSize = quietSize * opts.scale;
  const paths = [];
  for (let y = 0; y < modules.length; y += 1) {
    for (let x = 0; x < modules.length; x += 1) {
      if (modules[y][x]) paths.push(`M${x + opts.margin},${y + opts.margin}h1v1h-1z`);
    }
  }
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${quietSize} ${quietSize}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges">`,
    `<rect width="100%" height="100%" fill="${opts.light}"/>`,
    `<path fill="${opts.dark}" d="${paths.join('')}"/>`,
    '</svg>',
  ].join('');
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
          // Valid JSON default so the generic string prefill
          // ("The quick brown fox jumps over the lazy dog.") doesn't
          // land in the textarea and produce a parse error on first
          // click. Launch-audit 2026-04-24 (P1 #609).
          default: '{"example": true, "items": [1, 2, 3]}',
          description: 'The JSON text to parse and format.',
          // Minimal valid JSON so the first click succeeds on the public page.
          default: '{}',
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
  'regex-test': buildSpec(
    'regex-test',
    'Regex Test',
    'Test a JavaScript regular expression against sample text. Returns matches, capture groups, named captures, and indices.',
    'test',
    {
      type: 'object',
      required: ['pattern', 'text'],
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression pattern, without slash delimiters.' },
        flags: {
          type: 'string',
          default: '',
          description: 'Optional JavaScript regex flags. Allowed: g, i, m, s, u, y.',
        },
        text: { type: 'string', description: 'Sample text to scan, up to 100000 characters.' },
      },
    },
    {
      type: 'object',
      properties: {
        is_valid: { type: 'boolean' },
        error: { type: 'string' },
        pattern: { type: 'string' },
        flags: { type: 'string' },
        match_count: { type: 'integer' },
        matches: { type: 'array', items: { type: 'object' } },
        truncated: { type: 'boolean' },
      },
    },
    { pattern: '(?<word>floom)', flags: 'i', text: 'Floom turns scripts into apps.' },
  ),
  slugify: buildSpec(
    'slugify',
    'Slugify',
    'Convert any string into a URL-safe slug. Strips diacritics, collapses separators, lowercases by default, and can cap length.',
    'convert',
    {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Text to convert into a slug.' },
        separator: { type: 'string', default: '-', description: 'Single non-alphanumeric separator character.' },
        lowercase: { type: 'boolean', default: true, description: 'Lowercase the slug.' },
        max_length: { type: 'integer', minimum: 1, maximum: 200, description: 'Optional maximum output length.' },
      },
    },
    {
      type: 'object',
      properties: {
        slug: { type: 'string' },
        lowercase: { type: 'boolean' },
        separator: { type: 'string' },
        length: { type: 'integer' },
      },
    },
    { text: 'Floom Launch Week: 10 Tiny Apps!', separator: '-', lowercase: true, max_length: 48 },
  ),
  'url-encode': buildSpec(
    'url-encode',
    'URL Encode',
    'Percent-encode or decode full URLs, path segments, and query parameter values.',
    'convert',
    {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Text, URL, path segment, or query value to convert.' },
        mode: { type: 'string', enum: ['encode', 'decode'], default: 'encode' },
        component: { type: 'string', enum: ['full', 'path-segment', 'query'], default: 'full' },
        plus_for_space: { type: 'boolean', default: false, description: 'When encoding query values, output + instead of %20 for spaces.' },
      },
    },
    {
      type: 'object',
      properties: {
        mode: { type: 'string' },
        component: { type: 'string' },
        result: { type: 'string' },
        length: { type: 'integer' },
      },
    },
    { text: 'hello world & floom', mode: 'encode', component: 'query', plus_for_space: true },
  ),
  'utm-builder': buildSpec(
    'utm-builder',
    'UTM Builder',
    'Build campaign URLs with standard UTM parameters while preserving existing query strings and hash fragments.',
    'build',
    {
      type: 'object',
      required: ['base_url', 'source', 'medium', 'campaign'],
      properties: {
        base_url: { type: 'string', description: 'Absolute URL to tag.' },
        source: { type: 'string', description: 'utm_source, for example linkedin or newsletter.' },
        medium: { type: 'string', description: 'utm_medium, for example social, email, cpc.' },
        campaign: { type: 'string', description: 'utm_campaign name.' },
        term: { type: 'string', description: 'Optional utm_term.' },
        content: { type: 'string', description: 'Optional utm_content.' },
        id: { type: 'string', description: 'Optional utm_id.' },
      },
    },
    {
      type: 'object',
      properties: {
        url: { type: 'string' },
        query_string: { type: 'string' },
        utm: { type: 'object' },
      },
    },
    {
      base_url: 'https://floom.dev/apps',
      source: 'linkedin',
      medium: 'social',
      campaign: 'launch-week',
      content: 'day-2-qr',
    },
  ),
  'qr-code': buildSpec(
    'qr-code',
    'QR Code Studio',
    'Generate a dependency-free QR Code SVG and data URL from a short URL or text.',
    'generate',
    {
      type: 'object',
      required: ['text'],
      properties: {
        text: { type: 'string', description: 'Text or URL to encode. MVP supports up to 106 UTF-8 bytes.' },
        margin: { type: 'integer', minimum: 0, maximum: 16, default: 4, description: 'Quiet-zone modules around the QR.' },
        scale: { type: 'integer', minimum: 2, maximum: 32, default: 8, description: 'Pixels per QR module in the SVG width/height.' },
        dark: { type: 'string', default: '#111827', description: 'Dark module color as #RRGGBB.' },
        light: { type: 'string', default: '#ffffff', description: 'Background color as #RRGGBB.' },
      },
    },
    {
      type: 'object',
      properties: {
        svg: { type: 'string' },
        data_url: { type: 'string' },
        text_length: { type: 'integer' },
        version: { type: 'integer' },
        size: { type: 'integer' },
        margin: { type: 'integer' },
        scale: { type: 'integer' },
        error_correction: { type: 'string' },
      },
    },
    { text: 'https://floom.dev', margin: 4, scale: 8 },
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
  'regex-test': handleRegexTest,
  slugify: handleSlugify,
  'url-encode': handleUrlEncode,
  'utm-builder': handleUtmBuilder,
  'qr-code': handleQrCode,
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
