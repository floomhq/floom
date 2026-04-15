// W3.3 Stripe Connect partner app service.
//
// P.3 research (research/stripe-connect-validation.md) locked the spec:
//
//   - Stripe Connect Express accounts are the default. Creator never
//     leaves floom.dev; KYC runs through Stripe in the background.
//   - Standard accounts are an opt-in for creators who already run their
//     own Stripe (Gourav / Jannik profile). Same service surface.
//   - Direct charges only. The connected account is the merchant of
//     record. Floom is a facilitator and never touches the funds.
//   - application_fee_amount = floor(amount * 0.05). Stripe transfers
//     the 5% to Floom's platform balance automatically.
//   - Refund policy: if the refund happens within 30 days of the original
//     charge, Floom refunds its application fee too (`refund_application_fee:
//     true`). Beyond 30 days, the fee is retained — Stripe's underlying
//     processing fee is also gone, so the math stops working otherwise.
//   - Stripe Tax Basic is enabled per-merchant at onboarding by passing
//     `tax_settings: { defaults: { tax_behavior: 'inclusive', tax_code: 'txcd_99999999' } }`.
//     Floom is NOT the merchant of record, so tax filings stay on the
//     creator side — Floom just passes through the metadata.
//
// All public functions take a SessionContext and only operate on rows
// scoped to (workspace_id, user_id). User A can never read or mutate
// user B's Stripe account row, even if A guesses the database id.
//
// Test injection: `setStripeClient(client)` swaps the real SDK for an
// in-memory fake. The test harness uses this to run the full service
// without a live Stripe API key. See `test/stress/test-w33-*.mjs`.

import { db } from '../db.js';
import {
  newStripeAccountRowId,
  newStripeWebhookEventRowId,
} from '../lib/ids.js';
import type {
  SessionContext,
  StripeAccountRecord,
  StripeAccountType,
  StripeWebhookEventRecord,
} from '../types.js';

// ---------- errors ----------

export class StripeConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeConfigError';
  }
}

export class StripeClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeClientError';
  }
}

export class StripeAccountNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeAccountNotFoundError';
  }
}

export class StripeWebhookSignatureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StripeWebhookSignatureError';
  }
}

// ---------- platform fee math ----------

/**
 * Default application-fee percent. Locked to 5% in the roadmap; kept as a
 * constant + env var so a Floom-Pro tier can later override it without
 * touching the call sites. Range [0..100], integer math only.
 */
export const DEFAULT_APPLICATION_FEE_PERCENT = 5;

export function getApplicationFeePercent(): number {
  const raw = process.env.STRIPE_APPLICATION_FEE_PERCENT;
  if (!raw) return DEFAULT_APPLICATION_FEE_PERCENT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 100) {
    return DEFAULT_APPLICATION_FEE_PERCENT;
  }
  return n;
}

/**
 * Compute the application fee in the smallest currency unit (cents) for
 * an amount also in cents. We use `Math.floor` so Floom never collects
 * more than the contracted percentage even on odd cents:
 *
 *   $0.01  → floor(1 * 0.05)     = 0
 *   $9.99  → floor(999 * 0.05)   = 49
 *   $20.00 → floor(2000 * 0.05)  = 100
 *   $1000  → floor(100000 * 0.05) = 5000
 *
 * Throws if `amount` is not a non-negative finite integer.
 */
export function calculateApplicationFee(
  amount: number,
  percent: number = getApplicationFeePercent(),
): number {
  if (!Number.isFinite(amount) || !Number.isInteger(amount) || amount < 0) {
    throw new StripeClientError(
      `amount must be a non-negative integer (cents), got ${amount}`,
    );
  }
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    return 0;
  }
  // Multiply first to avoid floating-point dust, then floor.
  return Math.floor((amount * percent) / 100);
}

/** 30 days in milliseconds — the application-fee refund window. */
export const APPLICATION_FEE_REFUND_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Decide whether `refund_application_fee=true` should be passed when
 * issuing a refund. Based on the original charge's creation date.
 *
 * If `chargeCreatedUnix` is null/undefined we conservatively skip the
 * fee refund — better to under-refund than to fail the whole call.
 */
export function isWithinApplicationFeeRefundWindow(
  chargeCreatedUnix: number | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  if (typeof chargeCreatedUnix !== 'number' || chargeCreatedUnix <= 0) {
    return false;
  }
  const ageMs = nowMs - chargeCreatedUnix * 1000;
  return ageMs >= 0 && ageMs <= APPLICATION_FEE_REFUND_WINDOW_MS;
}

// ---------- minimal Stripe client interface ----------
//
// We define the smallest surface our service touches so tests can plug a
// fake without booting the real SDK. The real `stripe` package is
// dynamically imported on first use so CI runs that never call Stripe
// don't pay the parse cost.

export interface StripeAccountCreateParams {
  type: StripeAccountType;
  country?: string;
  email?: string | null;
  metadata?: Record<string, string>;
}

export interface StripeAccountObject {
  id: string;
  type: StripeAccountType;
  country: string | null;
  email: string | null;
  charges_enabled: boolean;
  payouts_enabled: boolean;
  details_submitted: boolean;
  requirements: Record<string, unknown> | null;
  metadata?: Record<string, string>;
}

export interface StripeAccountLinkParams {
  account: string;
  refresh_url: string;
  return_url: string;
  type: 'account_onboarding' | 'account_update';
}

export interface StripeAccountLinkObject {
  url: string;
  expires_at: number;
}

export interface StripePaymentIntentCreateParams {
  amount: number;
  currency: string;
  application_fee_amount?: number;
  on_behalf_of?: string;
  transfer_data?: { destination: string };
  metadata?: Record<string, string>;
  automatic_payment_methods?: { enabled: boolean };
  description?: string;
}

export interface StripePaymentIntentObject {
  id: string;
  amount: number;
  currency: string;
  application_fee_amount: number | null;
  status: string;
  client_secret: string | null;
  on_behalf_of: string | null;
  transfer_data: { destination: string } | null;
  metadata?: Record<string, string>;
  latest_charge?: string | null;
  created: number;
}

export interface StripeChargeObject {
  id: string;
  amount: number;
  currency: string;
  payment_intent: string | null;
  created: number;
  application_fee_amount?: number | null;
}

export interface StripeRefundCreateParams {
  payment_intent: string;
  amount?: number;
  refund_application_fee?: boolean;
  reverse_transfer?: boolean;
  metadata?: Record<string, string>;
}

export interface StripeRefundObject {
  id: string;
  amount: number;
  currency: string;
  payment_intent: string | null;
  status: string;
  metadata?: Record<string, string>;
}

export interface StripeSubscriptionCreateParams {
  customer: string;
  items: Array<{ price: string; quantity?: number }>;
  application_fee_percent?: number;
  on_behalf_of?: string;
  transfer_data?: { destination: string };
  metadata?: Record<string, string>;
  trial_period_days?: number;
}

export interface StripeSubscriptionObject {
  id: string;
  customer: string;
  status: string;
  application_fee_percent: number | null;
  metadata?: Record<string, string>;
  items: { data: Array<{ id: string; price: { id: string } }> };
}

export interface StripeWebhookEventObject {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: Record<string, unknown> };
  created: number;
}

export interface StripeClient {
  accounts: {
    create(params: StripeAccountCreateParams): Promise<StripeAccountObject>;
    retrieve(id: string): Promise<StripeAccountObject>;
  };
  accountLinks: {
    create(params: StripeAccountLinkParams): Promise<StripeAccountLinkObject>;
  };
  paymentIntents: {
    create(
      params: StripePaymentIntentCreateParams,
      options?: { stripeAccount?: string },
    ): Promise<StripePaymentIntentObject>;
    retrieve(
      id: string,
      options?: { stripeAccount?: string },
    ): Promise<StripePaymentIntentObject>;
  };
  charges: {
    retrieve(
      id: string,
      options?: { stripeAccount?: string },
    ): Promise<StripeChargeObject>;
  };
  refunds: {
    create(
      params: StripeRefundCreateParams,
      options?: { stripeAccount?: string },
    ): Promise<StripeRefundObject>;
  };
  subscriptions: {
    create(
      params: StripeSubscriptionCreateParams,
      options?: { stripeAccount?: string },
    ): Promise<StripeSubscriptionObject>;
  };
  webhooks: {
    constructEvent(
      payload: string | Buffer,
      header: string,
      secret: string,
    ): StripeWebhookEventObject;
  };
}

let clientInstance: StripeClient | null = null;

/**
 * Test hook: inject a custom Stripe client. Production code never calls
 * this; it calls `getStripeClient()` which lazily constructs the real
 * SDK on first use.
 */
export function setStripeClient(client: StripeClient | null): void {
  clientInstance = client;
}

/**
 * Return the active Stripe client. Constructs the real `stripe` SDK on
 * first use and caches it. Throws StripeConfigError if no API key is
 * configured.
 */
export async function getStripeClient(): Promise<StripeClient> {
  if (clientInstance) return clientInstance;

  const apiKey = process.env.STRIPE_SECRET_KEY;
  if (!apiKey || apiKey.length === 0) {
    throw new StripeConfigError(
      'STRIPE_SECRET_KEY is not set. Get a test key from https://dashboard.stripe.com/apikeys ' +
        'and set this env var. See docs/stripe-setup.md.',
    );
  }

  // Dynamic import so the heavy SDK only loads when actually needed.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let StripeCtor: any;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mod = (await import('stripe')) as any;
    StripeCtor = mod.default || mod.Stripe || mod;
  } catch (err) {
    throw new StripeConfigError(
      `'stripe' package is not installed. Run 'pnpm install' at the repo root. (${(err as Error).message})`,
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sdk: any = new StripeCtor(apiKey, {
    apiVersion: '2024-12-18.acacia',
    typescript: true,
  });

  // Thin adapter: keep the interface stable as Stripe evolves their SDK.
  clientInstance = {
    accounts: {
      create: (params) => sdk.accounts.create(params),
      retrieve: (id) => sdk.accounts.retrieve(id),
    },
    accountLinks: {
      create: (params) => sdk.accountLinks.create(params),
    },
    paymentIntents: {
      create: (params, options) => sdk.paymentIntents.create(params, options),
      retrieve: (id, options) => sdk.paymentIntents.retrieve(id, options),
    },
    charges: {
      retrieve: (id, options) => sdk.charges.retrieve(id, options),
    },
    refunds: {
      create: (params, options) => sdk.refunds.create(params, options),
    },
    subscriptions: {
      create: (params, options) => sdk.subscriptions.create(params, options),
    },
    webhooks: {
      constructEvent: (payload, header, secret) =>
        sdk.webhooks.constructEvent(payload, header, secret),
    },
  };
  return clientInstance;
}

// ---------- DB helpers ----------

function rowToAccount(row: Record<string, unknown>): StripeAccountRecord {
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id),
    user_id: String(row.user_id),
    stripe_account_id: String(row.stripe_account_id),
    account_type: row.account_type as StripeAccountType,
    country: row.country == null ? null : String(row.country),
    charges_enabled: row.charges_enabled ? 1 : 0,
    payouts_enabled: row.payouts_enabled ? 1 : 0,
    details_submitted: row.details_submitted ? 1 : 0,
    requirements_json: row.requirements_json == null ? null : String(row.requirements_json),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

function rowToWebhookEvent(
  row: Record<string, unknown>,
): StripeWebhookEventRecord {
  return {
    id: String(row.id),
    event_id: String(row.event_id),
    event_type: String(row.event_type),
    livemode: row.livemode ? 1 : 0,
    payload: String(row.payload),
    received_at: String(row.received_at),
  };
}

/**
 * Look up the caller's Stripe account row, scoped to (workspace, user).
 * Returns null if the caller has not onboarded yet.
 */
export function getCallerAccount(
  ctx: SessionContext,
): StripeAccountRecord | null {
  const row = db
    .prepare(
      `SELECT * FROM stripe_accounts
         WHERE workspace_id = ? AND user_id = ?`,
    )
    .get(ctx.workspace_id, ctx.user_id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToAccount(row);
}

/**
 * Look up a Stripe account row by Stripe account id. Used by the webhook
 * handler, which only knows the upstream id, not the caller. Returns null
 * if no local row exists for the given Stripe id.
 */
export function getAccountByStripeId(
  stripe_account_id: string,
): StripeAccountRecord | null {
  const row = db
    .prepare(`SELECT * FROM stripe_accounts WHERE stripe_account_id = ?`)
    .get(stripe_account_id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToAccount(row);
}

// ---------- public API ----------

export interface CreateAccountResult {
  account_id: string;
  onboarding_url: string;
  expires_at: string;
  account: StripeAccountRecord;
}

/**
 * Create an Express connected account for the caller and return an
 * onboarding link. Idempotent: if the caller already has a row, we
 * recycle the existing Stripe account id and just mint a fresh
 * onboarding URL (Stripe account links expire after a few minutes).
 */
export async function createExpressAccount(
  ctx: SessionContext,
  options: {
    country?: string;
    email?: string | null;
    account_type?: StripeAccountType;
  } = {},
): Promise<CreateAccountResult> {
  const account_type: StripeAccountType = options.account_type || 'express';
  const country = options.country || 'US';
  const refresh_url =
    process.env.STRIPE_CONNECT_ONBOARDING_REFRESH_URL ||
    'https://cloud.floom.dev/billing/refresh';
  const return_url =
    process.env.STRIPE_CONNECT_ONBOARDING_RETURN_URL ||
    'https://cloud.floom.dev/billing/return';

  const client = await getStripeClient();

  // Reuse existing Stripe account id if the caller already has one.
  const existing = getCallerAccount(ctx);
  let stripeAccountId: string;

  if (existing) {
    stripeAccountId = existing.stripe_account_id;
  } else {
    let acct: StripeAccountObject;
    try {
      acct = await client.accounts.create({
        type: account_type,
        country,
        email: options.email ?? null,
        metadata: {
          floom_workspace_id: ctx.workspace_id,
          floom_user_id: ctx.user_id,
        },
      });
    } catch (err) {
      throw new StripeClientError(
        `Stripe accounts.create failed: ${(err as Error).message}`,
      );
    }
    stripeAccountId = acct.id;

    const id = newStripeAccountRowId();
    db.prepare(
      `INSERT INTO stripe_accounts
         (id, workspace_id, user_id, stripe_account_id, account_type,
          country, charges_enabled, payouts_enabled, details_submitted,
          requirements_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(
      id,
      ctx.workspace_id,
      ctx.user_id,
      stripeAccountId,
      account_type,
      country,
      acct.charges_enabled ? 1 : 0,
      acct.payouts_enabled ? 1 : 0,
      acct.details_submitted ? 1 : 0,
      acct.requirements ? JSON.stringify(acct.requirements) : null,
    );
  }

  let link: StripeAccountLinkObject;
  try {
    link = await client.accountLinks.create({
      account: stripeAccountId,
      refresh_url,
      return_url,
      type: 'account_onboarding',
    });
  } catch (err) {
    throw new StripeClientError(
      `Stripe accountLinks.create failed: ${(err as Error).message}`,
    );
  }

  const stored = getCallerAccount(ctx);
  if (!stored) {
    throw new StripeClientError(
      'stripe_accounts row missing immediately after insert',
    );
  }
  return {
    account_id: stripeAccountId,
    onboarding_url: link.url,
    expires_at: new Date(link.expires_at * 1000).toISOString(),
    account: stored,
  };
}

/**
 * Refresh the caller's account state from Stripe and persist the new
 * capability flags. Used by the dashboard "check status" button and by
 * the `/api/stripe/connect/status` route.
 */
export async function getAccountStatus(
  ctx: SessionContext,
): Promise<StripeAccountRecord> {
  const existing = getCallerAccount(ctx);
  if (!existing) {
    throw new StripeAccountNotFoundError(
      'no Stripe account onboarded for caller',
    );
  }
  const client = await getStripeClient();
  let acct: StripeAccountObject;
  try {
    acct = await client.accounts.retrieve(existing.stripe_account_id);
  } catch (err) {
    throw new StripeClientError(
      `Stripe accounts.retrieve failed: ${(err as Error).message}`,
    );
  }
  return persistAccountState(existing.stripe_account_id, acct);
}

/**
 * Persist the latest account state from Stripe into the local row.
 * Shared by `getAccountStatus` (manual poll) and the `account.updated`
 * webhook handler. Returns the updated record.
 */
export function persistAccountState(
  stripe_account_id: string,
  acct: StripeAccountObject,
): StripeAccountRecord {
  const existing = getAccountByStripeId(stripe_account_id);
  if (!existing) {
    throw new StripeAccountNotFoundError(
      `no local stripe_accounts row for ${stripe_account_id}`,
    );
  }
  db.prepare(
    `UPDATE stripe_accounts
        SET charges_enabled = ?,
            payouts_enabled = ?,
            details_submitted = ?,
            requirements_json = ?,
            updated_at = datetime('now')
      WHERE stripe_account_id = ?`,
  ).run(
    acct.charges_enabled ? 1 : 0,
    acct.payouts_enabled ? 1 : 0,
    acct.details_submitted ? 1 : 0,
    acct.requirements ? JSON.stringify(acct.requirements) : null,
    stripe_account_id,
  );
  const updated = getAccountByStripeId(stripe_account_id);
  if (!updated) {
    throw new StripeClientError(
      `stripe_accounts row vanished after update for ${stripe_account_id}`,
    );
  }
  return updated;
}

export interface CreatePaymentIntentParams {
  amount: number; // smallest currency unit (cents)
  currency: string;
  metadata?: Record<string, string>;
  description?: string;
}

export interface CreatePaymentIntentResult {
  payment_intent_id: string;
  client_secret: string | null;
  amount: number;
  currency: string;
  application_fee_amount: number;
  status: string;
  destination: string;
}

/**
 * Create a direct charge on the caller's connected account. The 5%
 * application fee is auto-transferred to the Floom platform balance.
 *
 * The connected account must have `charges_enabled = 1` (set by the
 * `account.updated` webhook). Calls before onboarding completes return
 * StripeAccountNotFoundError so the dashboard can surface a clean
 * "complete onboarding" CTA.
 */
export async function createPaymentIntent(
  ctx: SessionContext,
  params: CreatePaymentIntentParams,
): Promise<CreatePaymentIntentResult> {
  if (!params || typeof params !== 'object') {
    throw new StripeClientError('params is required');
  }
  if (
    !Number.isFinite(params.amount) ||
    !Number.isInteger(params.amount) ||
    params.amount <= 0
  ) {
    throw new StripeClientError('amount must be a positive integer (cents)');
  }
  if (!params.currency || params.currency.length < 3) {
    throw new StripeClientError('currency is required (ISO 4217)');
  }

  const account = getCallerAccount(ctx);
  if (!account) {
    throw new StripeAccountNotFoundError(
      'no Stripe account onboarded for caller — call /api/stripe/connect/onboard first',
    );
  }
  if (!account.charges_enabled) {
    throw new StripeAccountNotFoundError(
      'Stripe account is not yet charges_enabled — finish onboarding first',
    );
  }

  const fee = calculateApplicationFee(params.amount);

  const client = await getStripeClient();
  let intent: StripePaymentIntentObject;
  try {
    intent = await client.paymentIntents.create(
      {
        amount: params.amount,
        currency: params.currency.toLowerCase(),
        application_fee_amount: fee,
        metadata: {
          ...(params.metadata || {}),
          floom_workspace_id: ctx.workspace_id,
          floom_user_id: ctx.user_id,
        },
        description: params.description,
        automatic_payment_methods: { enabled: true },
      },
      { stripeAccount: account.stripe_account_id },
    );
  } catch (err) {
    throw new StripeClientError(
      `Stripe paymentIntents.create failed: ${(err as Error).message}`,
    );
  }

  return {
    payment_intent_id: intent.id,
    client_secret: intent.client_secret ?? null,
    amount: intent.amount,
    currency: intent.currency,
    application_fee_amount: intent.application_fee_amount ?? fee,
    status: intent.status,
    destination: account.stripe_account_id,
  };
}

export interface RefundPaymentParams {
  payment_intent_id: string;
  amount?: number;
  metadata?: Record<string, string>;
}

export interface RefundPaymentResult {
  refund_id: string;
  amount: number;
  currency: string;
  status: string;
  application_fee_refunded: boolean;
}

/**
 * Refund a payment intent. If the original charge was created within
 * 30 days we also refund Floom's application fee (`refund_application_fee:
 * true`); beyond 30 days we keep it.
 *
 * Like `createPaymentIntent`, this is a direct-charge operation on the
 * caller's connected account. Cross-account refunds are rejected by
 * Stripe at the API level (the payment_intent simply doesn't exist on
 * the foreign account), so user A cannot refund user B's charge.
 */
export async function refundPayment(
  ctx: SessionContext,
  params: RefundPaymentParams,
): Promise<RefundPaymentResult> {
  if (!params || !params.payment_intent_id) {
    throw new StripeClientError('payment_intent_id is required');
  }
  if (
    params.amount !== undefined &&
    (!Number.isInteger(params.amount) || params.amount <= 0)
  ) {
    throw new StripeClientError('amount, if set, must be a positive integer');
  }

  const account = getCallerAccount(ctx);
  if (!account) {
    throw new StripeAccountNotFoundError(
      'no Stripe account onboarded for caller',
    );
  }

  const client = await getStripeClient();

  // Resolve the original charge so we can check the 30-day window.
  let intent: StripePaymentIntentObject;
  try {
    intent = await client.paymentIntents.retrieve(params.payment_intent_id, {
      stripeAccount: account.stripe_account_id,
    });
  } catch (err) {
    throw new StripeClientError(
      `Stripe paymentIntents.retrieve failed: ${(err as Error).message}`,
    );
  }

  const refundAppFee = isWithinApplicationFeeRefundWindow(intent.created);

  let refund: StripeRefundObject;
  try {
    refund = await client.refunds.create(
      {
        payment_intent: params.payment_intent_id,
        amount: params.amount,
        refund_application_fee: refundAppFee,
        metadata: {
          ...(params.metadata || {}),
          floom_workspace_id: ctx.workspace_id,
          floom_user_id: ctx.user_id,
        },
      },
      { stripeAccount: account.stripe_account_id },
    );
  } catch (err) {
    throw new StripeClientError(
      `Stripe refunds.create failed: ${(err as Error).message}`,
    );
  }

  return {
    refund_id: refund.id,
    amount: refund.amount,
    currency: refund.currency,
    status: refund.status,
    application_fee_refunded: refundAppFee,
  };
}

export interface CreateSubscriptionParams {
  customer_id: string;
  price_id: string;
  quantity?: number;
  trial_period_days?: number;
  metadata?: Record<string, string>;
}

export interface CreateSubscriptionResult {
  subscription_id: string;
  customer_id: string;
  status: string;
  application_fee_percent: number;
  destination: string;
  item_id: string;
}

/**
 * Create a subscription on the caller's connected account with a
 * 5% `application_fee_percent`. Supports flat-rate and metered prices —
 * the price object on Stripe declares `usage_type=metered` for per-run
 * billing. Floom reports usage via Stripe's `subscription_items` API
 * from the runner once W4.x ships the metering middleware.
 */
export async function createSubscription(
  ctx: SessionContext,
  params: CreateSubscriptionParams,
): Promise<CreateSubscriptionResult> {
  if (!params || !params.customer_id || !params.price_id) {
    throw new StripeClientError(
      'customer_id and price_id are required',
    );
  }

  const account = getCallerAccount(ctx);
  if (!account) {
    throw new StripeAccountNotFoundError(
      'no Stripe account onboarded for caller',
    );
  }
  if (!account.charges_enabled) {
    throw new StripeAccountNotFoundError(
      'Stripe account is not yet charges_enabled — finish onboarding first',
    );
  }

  const feePercent = getApplicationFeePercent();
  const client = await getStripeClient();
  let sub: StripeSubscriptionObject;
  try {
    sub = await client.subscriptions.create(
      {
        customer: params.customer_id,
        items: [
          {
            price: params.price_id,
            quantity: params.quantity,
          },
        ],
        application_fee_percent: feePercent,
        trial_period_days: params.trial_period_days,
        metadata: {
          ...(params.metadata || {}),
          floom_workspace_id: ctx.workspace_id,
          floom_user_id: ctx.user_id,
        },
      },
      { stripeAccount: account.stripe_account_id },
    );
  } catch (err) {
    throw new StripeClientError(
      `Stripe subscriptions.create failed: ${(err as Error).message}`,
    );
  }

  const item = sub.items?.data?.[0];
  return {
    subscription_id: sub.id,
    customer_id: sub.customer,
    status: sub.status,
    application_fee_percent: sub.application_fee_percent ?? feePercent,
    destination: account.stripe_account_id,
    item_id: item?.id ?? '',
  };
}

// ---------- webhook handling ----------

/**
 * Verify a Stripe webhook signature and parse the event. Throws
 * StripeWebhookSignatureError on any verification failure (missing
 * secret, missing header, bad signature, expired timestamp). Throws
 * StripeConfigError if the signing secret env var is not set.
 *
 * The parsed event must be passed to `handleWebhookEvent` which
 * dedupes by event id and dispatches to the right reducer.
 */
export async function verifyAndParseWebhook(
  rawBody: string | Buffer,
  signatureHeader: string | undefined | null,
): Promise<StripeWebhookEventObject> {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret || secret.length === 0) {
    throw new StripeConfigError(
      'STRIPE_WEBHOOK_SECRET is not set. See docs/stripe-setup.md.',
    );
  }
  if (!signatureHeader) {
    throw new StripeWebhookSignatureError('missing Stripe-Signature header');
  }
  const client = await getStripeClient();
  try {
    return client.webhooks.constructEvent(rawBody, signatureHeader, secret);
  } catch (err) {
    throw new StripeWebhookSignatureError(
      `signature verification failed: ${(err as Error).message}`,
    );
  }
}

export interface WebhookHandleResult {
  /** True if this is the first time we've seen this event id. */
  first_seen: boolean;
  /** Subset of the event we acted on, for tests + audit logs. */
  event_id: string;
  event_type: string;
}

/**
 * Persist an event id (idempotency) and dispatch to the reducer. Returns
 * `first_seen=false` if the same event id has already been processed.
 *
 * Reducers MUST be idempotent themselves — Stripe's at-least-once
 * delivery means we can be called twice for the same event under load,
 * even though the unique index makes the second insert a no-op.
 */
export function handleWebhookEvent(
  event: StripeWebhookEventObject,
): WebhookHandleResult {
  // Try to insert the dedupe row first. If it conflicts, this is a retry.
  let firstSeen = false;
  try {
    db.prepare(
      `INSERT INTO stripe_webhook_events
         (id, event_id, event_type, livemode, payload, received_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`,
    ).run(
      newStripeWebhookEventRowId(),
      event.id,
      event.type,
      event.livemode ? 1 : 0,
      JSON.stringify(event),
    );
    firstSeen = true;
  } catch (err) {
    // SQLITE_CONSTRAINT_UNIQUE on event_id → already processed.
    const msg = (err as Error).message || '';
    if (!/UNIQUE/i.test(msg)) throw err;
    firstSeen = false;
  }

  if (firstSeen) {
    dispatchEvent(event);
  }
  return {
    first_seen: firstSeen,
    event_id: event.id,
    event_type: event.type,
  };
}

/**
 * Dispatch a verified, first-seen event to the right reducer. We only
 * persist meaningful side effects for the four event types listed in
 * the spec; everything else is acknowledged but not acted on.
 */
function dispatchEvent(event: StripeWebhookEventObject): void {
  switch (event.type) {
    case 'account.updated': {
      const obj = event.data.object as unknown as Partial<StripeAccountObject>;
      if (obj && typeof obj.id === 'string') {
        const local = getAccountByStripeId(obj.id);
        if (local) {
          persistAccountState(obj.id, {
            id: obj.id,
            type: (obj.type as StripeAccountType) || local.account_type,
            country: obj.country ?? local.country,
            email: obj.email ?? null,
            charges_enabled: !!obj.charges_enabled,
            payouts_enabled: !!obj.payouts_enabled,
            details_submitted: !!obj.details_submitted,
            requirements:
              (obj.requirements as Record<string, unknown> | null) ?? null,
          });
        }
      }
      return;
    }
    case 'payment_intent.succeeded':
    case 'charge.refunded':
    case 'invoice.paid':
      // We persist the full payload via stripe_webhook_events above, which
      // is enough for v0.4 alpha. Real reducers (run usage, balance widgets)
      // ride on top of this in W4.x.
      return;
    default:
      return;
  }
}

// ---------- introspection helpers (read-only, used by routes + tests) ----

export function listWebhookEvents(opts?: {
  limit?: number;
}): StripeWebhookEventRecord[] {
  const limit = Math.max(1, Math.min(200, opts?.limit || 50));
  const rows = db
    .prepare(
      `SELECT * FROM stripe_webhook_events
         ORDER BY received_at DESC
         LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToWebhookEvent);
}

export function getWebhookEventById(
  event_id: string,
): StripeWebhookEventRecord | null {
  const row = db
    .prepare(`SELECT * FROM stripe_webhook_events WHERE event_id = ?`)
    .get(event_id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return rowToWebhookEvent(row);
}
