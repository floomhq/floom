// REFERENCE ONLY — staged for later, NOT wired into the Workeros app.
// Source: gate-app/lettersnap-agents src/services/whatsapp.ts (Meta WhatsApp Cloud API).
// LetterSnap-specific business logic removed: Firestore audit log, Stripe checkout
// CTA helper, payment button strings, response-text sanitizer dependency, German
// user-facing copy. What remains is the reusable Cloud API surface:
//   - config detection (env presence)
//   - webhook verification (challenge + X-Hub-Signature-256 HMAC)
//   - outbound text (with 4096-char chunking)
//   - media upload + send (document, audio)
//   - inbound media metadata lookup + remote media fetch
//
// Required env vars (Meta WhatsApp Cloud API):
//   WHATSAPP_PHONE_ID            — WhatsApp Business phone number ID
//   WHATSAPP_TOKEN               — Graph API access token (Bearer)
//   WHATSAPP_GRAPH_VERSION       — Graph API version (default v23.0)
//   WHATSAPP_WEBHOOK_VERIFY_TOKEN— webhook GET challenge verify token
//   WHATSAPP_APP_SECRET          — app secret for X-Hub-Signature-256 HMAC

import { createHmac, timingSafeEqual } from 'node:crypto';

const REQUIRED_ENV_KEYS = ['WHATSAPP_PHONE_ID', 'WHATSAPP_TOKEN'] as const;

const DEFAULT_GRAPH_VERSION = process.env.WHATSAPP_GRAPH_VERSION || 'v23.0';
const WHATSAPP_TEXT_MAX = 4096;

interface WhatsAppApiError {
  error?: { message?: string };
}

interface WhatsAppMediaMetadataResponse extends WhatsAppApiError {
  id?: string;
  url?: string;
  mime_type?: string;
}

export interface RemoteWhatsAppMedia {
  buffer: Buffer;
  base64: string;
  mimeType: string;
}

function getEnv(
  name:
    | typeof REQUIRED_ENV_KEYS[number]
    | 'WHATSAPP_GRAPH_VERSION'
    | 'WHATSAPP_WEBHOOK_VERIFY_TOKEN'
    | 'WHATSAPP_APP_SECRET',
): string | undefined {
  return process.env[name];
}

function getRequiredEnv(name: typeof REQUIRED_ENV_KEYS[number]): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is not set`);
  }
  return value;
}

function getGraphBase(): string {
  const version = String(getEnv('WHATSAPP_GRAPH_VERSION') || DEFAULT_GRAPH_VERSION).trim();
  return `https://graph.facebook.com/${version}`;
}

function getAuthHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${getRequiredEnv('WHATSAPP_TOKEN')}` };
}

function normalizeFetchedMimeType(value: string, fallback: string): string {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  return raw.split(';')[0]?.trim() || fallback;
}

function normalizeLineBreaks(text: string): string {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitTextIntoChunks(input: string): string[] {
  const raw = normalizeLineBreaks(input);
  if (!raw) return [];
  if (raw.length <= WHATSAPP_TEXT_MAX) return [raw];

  const chunks: string[] = [];
  const paragraphs = raw.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);

  for (const paragraph of paragraphs) {
    if (paragraph.length <= WHATSAPP_TEXT_MAX) {
      chunks.push(paragraph);
      continue;
    }

    const sentences = paragraph.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
    let current = '';

    for (const sentence of sentences) {
      const candidate = current ? `${current} ${sentence}` : sentence;
      if (candidate.length > WHATSAPP_TEXT_MAX && current) {
        chunks.push(current);
        current = sentence;
      } else if (candidate.length > WHATSAPP_TEXT_MAX) {
        let index = 0;
        while (index < sentence.length) {
          chunks.push(sentence.slice(index, index + WHATSAPP_TEXT_MAX));
          index += WHATSAPP_TEXT_MAX;
        }
        current = '';
      } else {
        current = candidate;
      }
    }

    if (current) chunks.push(current);
  }

  return chunks.filter(Boolean);
}

async function parseJsonSafe<T>(response: Response): Promise<T | null> {
  return response.json().then((value) => value as T).catch(() => null);
}

async function sendWhatsAppJson(payload: Record<string, unknown>): Promise<void> {
  const phoneId = getRequiredEnv('WHATSAPP_PHONE_ID');
  const response = await fetch(`${getGraphBase()}/${phoneId}/messages`, {
    method: 'POST',
    headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await parseJsonSafe<WhatsAppApiError>(response);
    throw new Error(body?.error?.message || `WhatsApp API error (HTTP ${response.status})`);
  }
}

async function uploadWhatsAppMedia(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
  const phoneId = getRequiredEnv('WHATSAPP_PHONE_ID');
  const form = new FormData();
  form.append('messaging_product', 'whatsapp');
  form.append('type', mimeType);
  form.append('file', new Blob([buffer], { type: mimeType }), filename);

  const response = await fetch(`${getGraphBase()}/${phoneId}/media`, {
    method: 'POST',
    headers: getAuthHeaders(),
    body: form,
  });

  const body = await parseJsonSafe<{ id?: string } & WhatsAppApiError>(response);
  if (!response.ok || !body?.id) {
    throw new Error(body?.error?.message || `WhatsApp media upload error (HTTP ${response.status})`);
  }

  return String(body.id);
}

const MAX_REMOTE_MEDIA_BYTES = 40 * 1024 * 1024;

export async function fetchRemoteWhatsAppMedia(url: string, mimeTypeHint?: string): Promise<RemoteWhatsAppMedia> {
  const headers: Record<string, string> = {};
  try {
    const host = new URL(url).hostname;
    if (host.endsWith('facebook.com') || host.endsWith('fbsbx.com') || host.endsWith('fbcdn.net')) {
      const token = process.env.WHATSAPP_TOKEN;
      if (token) headers.Authorization = `Bearer ${token}`;
    }
  } catch {
    // best-effort: attempt fetch even if URL parse fails
  }

  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`Remote media fetch failed (HTTP ${response.status})`);
  }

  const contentLengthRaw = response.headers.get('content-length');
  const contentLength = contentLengthRaw ? Number(contentLengthRaw) : NaN;
  if (Number.isFinite(contentLength) && contentLength > MAX_REMOTE_MEDIA_BYTES) {
    throw new Error(`Remote media too large (${contentLength} bytes, limit ${MAX_REMOTE_MEDIA_BYTES})`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength > MAX_REMOTE_MEDIA_BYTES) {
    throw new Error(`Remote media too large (${buffer.byteLength} bytes, limit ${MAX_REMOTE_MEDIA_BYTES})`);
  }

  const mimeType = normalizeFetchedMimeType(
    mimeTypeHint || response.headers.get('content-type') || '',
    'application/octet-stream',
  );

  return { buffer, base64: buffer.toString('base64'), mimeType };
}

export function isWhatsAppConfigured(): boolean {
  return REQUIRED_ENV_KEYS.every((key) => Boolean(getEnv(key)));
}

export function getMissingWhatsAppConfig(): string[] {
  return REQUIRED_ENV_KEYS.filter((key) => !getEnv(key));
}

export function getWhatsAppWebhookVerifyToken(): string | undefined {
  const token = String(getEnv('WHATSAPP_WEBHOOK_VERIFY_TOKEN') || '').trim();
  return token || undefined;
}

// GET webhook verification (Meta calls this once when you register the callback URL).
export function verifyWhatsAppWebhookChallenge(mode: string | undefined, verifyToken: string | undefined): boolean {
  const expectedToken = getWhatsAppWebhookVerifyToken();
  if (mode !== 'subscribe' || !expectedToken || !verifyToken) {
    return false;
  }
  return verifyToken === expectedToken;
}

// POST webhook signature verification (X-Hub-Signature-256, HMAC-SHA256 of raw body).
export function verifyWhatsAppWebhookSignature(signatureHeader: string | undefined, rawBody: Buffer | undefined): boolean {
  const appSecret = String(getEnv('WHATSAPP_APP_SECRET') || '').trim();
  if (!appSecret) {
    // No app secret configured — caller must decide whether to fail open in dev.
    return true;
  }
  if (!signatureHeader || !rawBody || !signatureHeader.startsWith('sha256=')) {
    return false;
  }

  const expectedSignature = `sha256=${createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
  const expectedBuf = Buffer.from(expectedSignature);
  const providedBuf = Buffer.from(signatureHeader);
  if (expectedBuf.length !== providedBuf.length) return false;

  try {
    return timingSafeEqual(providedBuf, expectedBuf);
  } catch {
    return false;
  }
}

export async function getWhatsAppMediaMetadata(mediaId: string): Promise<{ id: string; url: string; mimeType?: string }> {
  const trimmedId = String(mediaId || '').trim();
  if (!trimmedId) throw new Error('WhatsApp media id missing');

  const response = await fetch(`${getGraphBase()}/${trimmedId}`, {
    method: 'GET',
    headers: getAuthHeaders(),
  });

  const body = await parseJsonSafe<WhatsAppMediaMetadataResponse>(response);
  const url = String(body?.url || '').trim();
  if (!response.ok || !url) {
    throw new Error(body?.error?.message || `WhatsApp media metadata error (HTTP ${response.status})`);
  }

  const mimeType = normalizeFetchedMimeType(String(body?.mime_type || '').trim(), '');
  return { id: String(body?.id || trimmedId), url, mimeType: mimeType || undefined };
}

export async function sendWhatsAppText(to: string, text: string): Promise<void> {
  if (!to) throw new Error('WhatsApp recipient missing');

  const chunks = splitTextIntoChunks(text);
  if (chunks.length === 0) throw new Error('WhatsApp text missing');

  for (const chunk of chunks) {
    await sendWhatsAppJson({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: chunk },
    });
  }
}

export async function sendWhatsAppTypingIndicator(messageId: string): Promise<void> {
  const trimmedMessageId = String(messageId || '').trim();
  if (!trimmedMessageId) throw new Error('WhatsApp messageId for typing indicator missing');

  await sendWhatsAppJson({
    messaging_product: 'whatsapp',
    status: 'read',
    message_id: trimmedMessageId,
    typing_indicator: { type: 'text' },
  });
}

export async function sendWhatsAppDocument(
  to: string,
  buffer: Buffer,
  filename: string,
  caption?: string,
): Promise<void> {
  if (!to) throw new Error('WhatsApp recipient missing');

  const mediaId = await uploadWhatsAppMedia(buffer, 'application/pdf', filename || 'document.pdf');
  await sendWhatsAppJson({
    messaging_product: 'whatsapp',
    to,
    type: 'document',
    document: {
      id: mediaId,
      filename: filename || 'document.pdf',
      ...(caption ? { caption: String(caption).trim().slice(0, 1024) } : {}),
    },
  });
}

export async function sendWhatsAppAudio(
  to: string,
  buffer: Buffer,
  mimeType = 'audio/mpeg',
  filename = 'response.mp3',
): Promise<void> {
  if (!to) throw new Error('WhatsApp recipient missing');

  const mediaId = await uploadWhatsAppMedia(buffer, mimeType, filename);
  await sendWhatsAppJson({
    messaging_product: 'whatsapp',
    to,
    type: 'audio',
    audio: { id: mediaId },
  });
}
