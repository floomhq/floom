// W3.3 /api/stripe routes.
//
// Surface for the Stripe Connect partner app. Every payment / refund /
// subscription route is auth-gated to the caller (workspace + user) via
// `resolveUserContext`, so user A can never operate on user B's Stripe
// account row even when it knows the upstream Stripe account id.
//
// Routes:
//   POST   /api/stripe/connect/onboard
//   GET    /api/stripe/connect/status
//   POST   /api/stripe/payments
//   POST   /api/stripe/refunds
//   POST   /api/stripe/subscriptions
//   POST   /api/stripe/webhook            (raw body, signature verified)
//
// Error envelope: `{ error, code, details? }`. No raw stack traces.

import { Hono } from 'hono';
import { z } from 'zod';
import { resolveUserContext } from '../services/session.js';
import {
  StripeAccountNotFoundError,
  StripeClientError,
  StripeConfigError,
  StripeWebhookSignatureError,
  createExpressAccount,
  createPaymentIntent,
  createSubscription,
  getAccountStatus,
  getCallerAccount,
  handleWebhookEvent,
  refundPayment,
  verifyAndParseWebhook,
} from '../services/stripe-connect.js';

export const stripeRouter = new Hono();

// ---------- Zod validators ----------

const OnboardBody = z.object({
  country: z
    .string()
    .min(2)
    .max(2)
    .regex(/^[A-Za-z]{2}$/, 'country must be a 2-letter ISO code')
    .optional(),
  email: z.string().email().optional(),
  account_type: z.enum(['express', 'standard']).optional(),
});

const PaymentBody = z.object({
  amount: z.number().int().positive().max(99_999_999),
  currency: z
    .string()
    .min(3)
    .max(3)
    .regex(/^[A-Za-z]{3}$/, 'currency must be a 3-letter ISO code'),
  description: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const RefundBody = z.object({
  payment_intent_id: z.string().min(3).max(256),
  amount: z.number().int().positive().max(99_999_999).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

const SubscriptionBody = z.object({
  customer_id: z.string().min(3).max(256),
  price_id: z.string().min(3).max(256),
  quantity: z.number().int().positive().max(1_000_000).optional(),
  trial_period_days: z.number().int().nonnegative().max(730).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
});

// ---------- helpers ----------

function errorEnvelope(err: unknown): {
  body: Record<string, unknown>;
  status: number;
} {
  if (err instanceof StripeConfigError) {
    return {
      body: { error: err.message, code: 'stripe_config_missing' },
      status: 400,
    };
  }
  if (err instanceof StripeAccountNotFoundError) {
    return {
      body: { error: err.message, code: 'stripe_account_not_found' },
      status: 404,
    };
  }
  if (err instanceof StripeWebhookSignatureError) {
    return {
      body: { error: err.message, code: 'stripe_webhook_signature_failed' },
      status: 400,
    };
  }
  if (err instanceof StripeClientError) {
    return {
      body: { error: err.message, code: 'stripe_client_error' },
      status: 502,
    };
  }
  return {
    body: { error: (err as Error).message, code: 'unexpected_error' },
    status: 500,
  };
}

function serializeAccount(
  acct: ReturnType<typeof getCallerAccount>,
): Record<string, unknown> | null {
  if (!acct) return null;
  let requirements: unknown = null;
  if (acct.requirements_json) {
    try {
      requirements = JSON.parse(acct.requirements_json);
    } catch {
      requirements = null;
    }
  }
  return {
    id: acct.id,
    stripe_account_id: acct.stripe_account_id,
    account_type: acct.account_type,
    country: acct.country,
    charges_enabled: !!acct.charges_enabled,
    payouts_enabled: !!acct.payouts_enabled,
    details_submitted: !!acct.details_submitted,
    requirements,
    created_at: acct.created_at,
    updated_at: acct.updated_at,
  };
}

// ---------- POST /connect/onboard ----------

stripeRouter.post('/connect/onboard', async (c) => {
  const ctx = resolveUserContext(c);
  let body: unknown = {};
  // Body is optional — defaults pull country=US.
  try {
    const text = await c.req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = OnboardBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid body shape',
        code: 'invalid_body',
        details: parsed.error.flatten(),
      },
      400,
    );
  }
  try {
    const result = await createExpressAccount(ctx, parsed.data);
    return c.json({
      account_id: result.account_id,
      onboarding_url: result.onboarding_url,
      expires_at: result.expires_at,
      account: serializeAccount(result.account),
    });
  } catch (err) {
    const env = errorEnvelope(err);
    return c.json(env.body, env.status as 400 | 404 | 500 | 502);
  }
});

// ---------- GET /connect/status ----------

stripeRouter.get('/connect/status', async (c) => {
  const ctx = resolveUserContext(c);
  // Read the local row first so a caller without an onboarded account
  // gets a clean 404 instead of a Stripe round-trip.
  const local = getCallerAccount(ctx);
  if (!local) {
    return c.json(
      {
        error: 'no Stripe account onboarded for caller',
        code: 'stripe_account_not_found',
      },
      404,
    );
  }
  // Allow ?refresh=false to skip the upstream poll for hot-path reads.
  const refresh = c.req.query('refresh') !== 'false';
  if (!refresh) {
    return c.json({ account: serializeAccount(local) });
  }
  try {
    const updated = await getAccountStatus(ctx);
    return c.json({ account: serializeAccount(updated) });
  } catch (err) {
    const env = errorEnvelope(err);
    return c.json(env.body, env.status as 400 | 404 | 500 | 502);
  }
});

// ---------- POST /payments ----------

stripeRouter.post('/payments', async (c) => {
  const ctx = resolveUserContext(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = PaymentBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid body shape',
        code: 'invalid_body',
        details: parsed.error.flatten(),
      },
      400,
    );
  }
  try {
    const result = await createPaymentIntent(ctx, parsed.data);
    return c.json(result);
  } catch (err) {
    const env = errorEnvelope(err);
    return c.json(env.body, env.status as 400 | 404 | 500 | 502);
  }
});

// ---------- POST /refunds ----------

stripeRouter.post('/refunds', async (c) => {
  const ctx = resolveUserContext(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = RefundBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid body shape',
        code: 'invalid_body',
        details: parsed.error.flatten(),
      },
      400,
    );
  }
  try {
    const result = await refundPayment(ctx, parsed.data);
    return c.json(result);
  } catch (err) {
    const env = errorEnvelope(err);
    return c.json(env.body, env.status as 400 | 404 | 500 | 502);
  }
});

// ---------- POST /subscriptions ----------

stripeRouter.post('/subscriptions', async (c) => {
  const ctx = resolveUserContext(c);
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Body must be JSON', code: 'invalid_body' }, 400);
  }
  const parsed = SubscriptionBody.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        error: 'Invalid body shape',
        code: 'invalid_body',
        details: parsed.error.flatten(),
      },
      400,
    );
  }
  try {
    const result = await createSubscription(ctx, parsed.data);
    return c.json(result);
  } catch (err) {
    const env = errorEnvelope(err);
    return c.json(env.body, env.status as 400 | 404 | 500 | 502);
  }
});

// ---------- POST /webhook ----------
//
// Stripe webhook receiver. Reads the raw request body (no JSON parse,
// because the signature is computed against the exact bytes), verifies
// the signature, dedupes by event id, and dispatches to the reducer.
//
// Returns 200 even on duplicates so Stripe stops retrying. Returns 400
// on missing/invalid signature. The endpoint is intentionally NOT
// behind any auth gate — Stripe authenticates itself via the signature.

stripeRouter.post('/webhook', async (c) => {
  let raw: string;
  try {
    raw = await c.req.text();
  } catch {
    return c.json({ error: 'failed to read body', code: 'invalid_body' }, 400);
  }
  const sig =
    c.req.header('stripe-signature') ||
    c.req.header('Stripe-Signature') ||
    null;
  let event;
  try {
    event = await verifyAndParseWebhook(raw, sig);
  } catch (err) {
    const env = errorEnvelope(err);
    return c.json(env.body, env.status as 400 | 500);
  }
  try {
    const result = handleWebhookEvent(event);
    return c.json({
      ok: true,
      first_seen: result.first_seen,
      event_id: result.event_id,
      event_type: result.event_type,
    });
  } catch (err) {
    return c.json(
      {
        error: (err as Error).message,
        code: 'webhook_handler_failed',
      },
      500,
    );
  }
});
