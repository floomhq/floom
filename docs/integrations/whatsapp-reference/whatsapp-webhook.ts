// REFERENCE ONLY — staged for later, NOT wired into the Floom app.
// Source: gate-app/lettersnap-agents src/services/whatsapp-webhook.ts.
// Meta WhatsApp Cloud API inbound webhook payload normalizer. LetterSnap-specific
// Cloudinary upload was removed; media is returned as a base64 data URL plus an
// optional remote URL the caller can re-host. Depends on whatsapp.ts (sibling file)
// for getWhatsAppMediaMetadata + fetchRemoteWhatsAppMedia.
//
// Turns a raw Meta `whatsapp_business_account` webhook body into a flat list of
// NormalizedWhatsAppInboundEvent (text/image/document/audio), each carrying the
// sender wa_id, message id, profile name, and (for media) the downloaded bytes.

import {
  fetchRemoteWhatsAppMedia,
  getWhatsAppMediaMetadata,
} from './whatsapp.js';

type WhatsAppInboundType = 'text' | 'image' | 'document' | 'audio';

export interface NormalizedWhatsAppInboundEvent {
  source: 'whatsapp';
  messageId: string;
  userId: string;
  profileName?: string;
  timestamp?: string;
  type: WhatsAppInboundType;
  text?: string;
  caption?: string;
  media?: {
    dataUrl?: string;
    url?: string;
    mimeType: string;
    filename?: string;
  };
}

interface MetaWebhookPayload {
  object?: string;
  entry?: MetaWebhookEntry[];
}

interface MetaWebhookEntry {
  changes?: MetaWebhookChange[];
}

interface MetaWebhookChange {
  field?: string;
  value?: MetaWebhookValue;
}

interface MetaWebhookValue {
  contacts?: MetaContact[];
  messages?: MetaMessage[];
}

interface MetaContact {
  wa_id?: string;
  profile?: { name?: string };
}

interface MetaTextMessage {
  body?: string;
}

interface MetaMediaMessageContent {
  id?: string;
  mime_type?: string;
  caption?: string;
  filename?: string;
}

interface MetaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  text?: MetaTextMessage;
  image?: MetaMediaMessageContent;
  document?: MetaMediaMessageContent;
  audio?: MetaMediaMessageContent;
}

function normalizeWaId(value: string): string {
  return String(value || '').replace(/\D/g, '');
}

function isSupportedInboundType(value: string): value is WhatsAppInboundType {
  return value === 'text' || value === 'image' || value === 'document' || value === 'audio';
}

function getMetaContactsByWaId(contacts: MetaContact[] | undefined): Map<string, MetaContact> {
  const map = new Map<string, MetaContact>();
  for (const contact of contacts || []) {
    const waId = normalizeWaId(String(contact?.wa_id || ''));
    if (waId) map.set(waId, contact);
  }
  return map;
}

function getMediaContent(message: MetaMessage, type: Exclude<WhatsAppInboundType, 'text'>): MetaMediaMessageContent | undefined {
  if (type === 'image') return message.image;
  if (type === 'document') return message.document;
  return message.audio;
}

function buildDataUrl(mimeType: string, base64: string): string {
  return `data:${mimeType};base64,${base64}`;
}

async function normalizeMediaMessage(
  message: MetaMessage,
  type: Exclude<WhatsAppInboundType, 'text'>,
  profileName: string | undefined,
): Promise<NormalizedWhatsAppInboundEvent | null> {
  const messageId = String(message.id || '').trim();
  const userId = normalizeWaId(String(message.from || ''));
  if (!messageId || !userId) return null;

  const media = getMediaContent(message, type);
  const mediaId = String(media?.id || '').trim();
  if (!mediaId) return null;

  const metadata = await getWhatsAppMediaMetadata(mediaId);
  const downloaded = await fetchRemoteWhatsAppMedia(metadata.url, media?.mime_type || metadata.mimeType);
  const mimeType = String(media?.mime_type || metadata.mimeType || downloaded.mimeType || 'application/octet-stream').trim();
  const dataUrl = buildDataUrl(mimeType, downloaded.base64);

  return {
    source: 'whatsapp',
    messageId,
    userId,
    profileName,
    timestamp: typeof message.timestamp === 'string' ? message.timestamp : undefined,
    type,
    text: '',
    caption: String(media?.caption || '').trim(),
    media: {
      dataUrl,
      // url left undefined: caller may re-host the dataUrl (e.g. S3/Cloudinary) if desired.
      mimeType,
      ...(String(media?.filename || '').trim() ? { filename: String(media?.filename || '').trim() } : {}),
    },
  };
}

function normalizeTextMessage(message: MetaMessage, profileName: string | undefined): NormalizedWhatsAppInboundEvent | null {
  const messageId = String(message.id || '').trim();
  const userId = normalizeWaId(String(message.from || ''));
  if (!messageId || !userId) return null;

  return {
    source: 'whatsapp',
    messageId,
    userId,
    profileName,
    timestamp: typeof message.timestamp === 'string' ? message.timestamp : undefined,
    type: 'text',
    text: String(message.text?.body || ''),
    caption: '',
  };
}

export function isNormalizedWhatsAppInboundEvent(payload: unknown): payload is NormalizedWhatsAppInboundEvent {
  if (!payload || typeof payload !== 'object') return false;
  const candidate = payload as Partial<NormalizedWhatsAppInboundEvent>;
  return String(candidate.source || '').trim().toLowerCase() === 'whatsapp';
}

export async function preprocessMetaWhatsAppWebhook(payload: unknown): Promise<NormalizedWhatsAppInboundEvent[]> {
  const body = payload as MetaWebhookPayload | null;
  if (String(body?.object || '').trim().toLowerCase() !== 'whatsapp_business_account') {
    return [];
  }

  const normalizedEvents: NormalizedWhatsAppInboundEvent[] = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      if (String(change?.field || '').trim().toLowerCase() !== 'messages') continue;

      const contactsByWaId = getMetaContactsByWaId(change.value?.contacts);
      for (const message of change.value?.messages || []) {
        const type = String(message.type || '').trim().toLowerCase();
        if (!isSupportedInboundType(type)) continue;

        const profileName = contactsByWaId.get(normalizeWaId(String(message.from || '')))?.profile?.name;
        const normalized = type === 'text'
          ? normalizeTextMessage(message, profileName)
          : await normalizeMediaMessage(message, type, profileName);

        if (normalized) normalizedEvents.push(normalized);
      }
    }
  }

  return normalizedEvents;
}
