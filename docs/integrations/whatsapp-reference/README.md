# WhatsApp integration — reference code (staged, NOT active)

**Status: staged for later. None of this is wired into the Workeros app.**
These files are inert reference primitives. Nothing in the live app imports them.

## Source

Extracted and cleaned from [`gate-app/lettersnap-agents`](https://github.com/gate-app/lettersnap-agents):
- `src/services/whatsapp.ts` → [`whatsapp.ts`](./whatsapp.ts)
- `src/services/whatsapp-webhook.ts` → [`whatsapp-webhook.ts`](./whatsapp-webhook.ts)

LetterSnap-specific business logic was stripped: Stripe checkout / `cta_url` payment
button, Firestore outbound audit log, Cloudinary media re-hosting, German user-facing
copy, and the `response-text` sanitizer dependency. What remains is the reusable
**Meta WhatsApp Cloud API** surface.

## What this is

The **official Meta WhatsApp Cloud API** (Graph API at `graph.facebook.com`), not an
unofficial library like Baileys. This is the same approach ExampleCo's production
WhatsApp bot uses. It is webhook-based: Meta hosts the WhatsApp connection; you
register an HTTPS callback URL and exchange JSON over the Graph API.

### `whatsapp.ts` — outbound + verification primitives
- `isWhatsAppConfigured()` / `getMissingWhatsAppConfig()` — env presence checks
- `verifyWhatsAppWebhookChallenge(mode, token)` — GET handshake when registering the callback URL
- `verifyWhatsAppWebhookSignature(header, rawBody)` — `X-Hub-Signature-256` HMAC-SHA256 of the raw POST body
- `sendWhatsAppText(to, text)` — outbound text, auto-chunked to the 4096-char limit
- `sendWhatsAppDocument(to, buffer, filename, caption?)` — upload + send a PDF/document
- `sendWhatsAppAudio(to, buffer, mimeType?, filename?)` — upload + send audio
- `sendWhatsAppTypingIndicator(messageId)` — read receipt + typing indicator
- `getWhatsAppMediaMetadata(mediaId)` / `fetchRemoteWhatsAppMedia(url)` — download inbound media (40 MB cap)

### `whatsapp-webhook.ts` — inbound normalizer
- `preprocessMetaWhatsAppWebhook(payload)` — turns a raw `whatsapp_business_account`
  webhook body into a flat `NormalizedWhatsAppInboundEvent[]` (text/image/document/audio),
  each with sender `wa_id`, message id, profile name, and downloaded media bytes.
- `isNormalizedWhatsAppInboundEvent(payload)` — type guard.

Depends only on `whatsapp.ts` (sibling). No other app imports.

## Required env vars (5)

| Var | Purpose |
|-----|---------|
| `WHATSAPP_PHONE_ID` | WhatsApp Business phone number ID |
| `WHATSAPP_TOKEN` | Graph API access token (Bearer) |
| `WHATSAPP_GRAPH_VERSION` | Graph API version (default `v23.0`) |
| `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | GET challenge verify token (you choose this) |
| `WHATSAPP_APP_SECRET` | App secret for `X-Hub-Signature-256` HMAC |

## How to wire it later (not done here)

1. Add the 5 env vars above to the API service config + `.env.example`.
2. Add an inbound webhook route:
   - `GET` → answer Meta's challenge via `verifyWhatsAppWebhookChallenge`.
   - `POST` → verify `verifyWhatsAppWebhookSignature` against the **raw** body, then
     `preprocessMetaWhatsAppWebhook(body)` and route each event to a worker.
3. Reply via `sendWhatsAppText` / `sendWhatsAppDocument`.

Until those steps are taken, this directory is documentation, not code paths.
