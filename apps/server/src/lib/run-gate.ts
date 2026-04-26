import type { Context } from 'hono';
import { checkRunRateLimit } from './rate-limit.js';
import {
  RUN_BODY_LIMIT_BYTES,
  isRunBodyLimitDisabled,
} from '../middleware/body-size.js';
import { hasValidAdminBearer } from './auth.js';
import { extractIp } from './client-ip.js';
import {
  byokRequiredResponse,
  decideByok,
  hashUserAgent,
  isByokGated,
  recordFreeRun,
} from './byok-gate.js';
import * as userSecrets from '../services/user_secrets.js';
import type { SessionContext } from '../types.js';

export const USER_API_KEY_HEADER = 'x-user-api-key';
const BYOK_INPUT_KEYS = new Set([
  'gemini_api_key',
  'GEMINI_API_KEY',
  'x_user_api_key',
  'X-User-Api-Key',
]);

export type RunGateResult =
  | { ok: true }
  | {
      ok: false;
      status: 413 | 429;
      body: Record<string, unknown>;
      headers?: Record<string, string>;
    };

export interface RunByokGateAllowed {
  ok: true;
  perCallSecrets?: Record<string, string>;
}

export type RunByokGateResult = RunByokGateAllowed | Exclude<RunGateResult, { ok: true }>;

export function extractUserApiKeyValue(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  // Minimum plausible length for a Google AI Studio key (prefix "AIza" +
  // 35 chars). We do not hard-validate here; the app runtime reports whether
  // the key actually works.
  if (trimmed.length < 20) return null;
  return trimmed;
}

export function extractUserApiKey(c: Context): string | null {
  return extractUserApiKeyValue(c.req.header(USER_API_KEY_HEADER));
}

export function extractByokInputSecret(
  inputs: Record<string, unknown>,
): { apiKey: string | null; inputs: Record<string, unknown> } {
  let apiKey: string | null = null;
  let changed = false;
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inputs)) {
    if (BYOK_INPUT_KEYS.has(key)) {
      apiKey = apiKey ?? extractUserApiKeyValue(value);
      changed = true;
      continue;
    }
    cleaned[key] = value;
  }
  return { apiKey, inputs: changed ? cleaned : inputs };
}

export function runGate(
  c: Context,
  ctx: SessionContext,
  options: { slug?: string | null; checkBody?: boolean; checkRate?: boolean } = {},
): RunGateResult {
  const { slug = null, checkBody = true, checkRate = true } = options;

  if (checkBody && !isRunBodyLimitDisabled()) {
    const method = c.req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      const lenHeader = c.req.header('content-length');
      if (lenHeader) {
        const len = Number(lenHeader);
        if (Number.isFinite(len) && len > RUN_BODY_LIMIT_BYTES) {
          return {
            ok: false,
            status: 413,
            body: {
              error: 'request_body_too_large',
              message: `Request body is ${len} bytes; max allowed for run endpoints is ${RUN_BODY_LIMIT_BYTES}.`,
              limit_bytes: RUN_BODY_LIMIT_BYTES,
            },
          };
        }
      }
    }
  }

  if (checkRate) {
    const rate = checkRunRateLimit(c, ctx, slug);
    if (!rate.ok) return rate;
  }

  return { ok: true };
}

function hasUserVaultGeminiKey(ctx: SessionContext): boolean {
  try {
    return userSecrets.listMasked(ctx).some((secret) => secret.key === 'GEMINI_API_KEY');
  } catch {
    return false;
  }
}

export function runByokGate(
  c: Context,
  ctx: SessionContext,
  slug: string,
  providedApiKey: string | null,
  options: { allowUserVaultKey?: boolean } = {},
): RunByokGateResult {
  if (!isByokGated(slug) || hasValidAdminBearer(c)) return { ok: true };

  const hasProvidedKey = providedApiKey !== null;
  const hasVaultKey = options.allowUserVaultKey === true && hasUserVaultGeminiKey(ctx);
  const ip = extractIp(c);
  const uaHash = hashUserAgent(c.req.header('user-agent'));
  const decision = decideByok(ip, slug, hasProvidedKey || hasVaultKey, undefined, uaHash);
  if (decision.block) {
    return {
      ok: false,
      status: 429,
      body: byokRequiredResponse(slug, decision.usage, decision.limit),
    };
  }

  if (hasProvidedKey) {
    return {
      ok: true,
      perCallSecrets: { GEMINI_API_KEY: providedApiKey },
    };
  }

  if (!hasVaultKey) {
    recordFreeRun(ip, slug, undefined, uaHash);
    if (decision.tightened) {
      // eslint-disable-next-line no-console
      console.warn(`[byok-gate] subnet burst tightened limit ip=${ip} slug=${slug}`);
    }
  }

  return { ok: true };
}
