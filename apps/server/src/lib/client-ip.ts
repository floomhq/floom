// Shared client IP extraction for rate limiting, sign-in throttling, waitlist,
// etc. Isolated from rate-limit.ts so importers that only need the IP (e.g.
// signin-progressive-delay stress tests) do not pull in auth / Better Auth / db.

import type { Context } from 'hono';
import { BlockList, isIP } from 'node:net';

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function defaultTrustedProxyHopCount(): number {
  return envNumber('FLOOM_TRUSTED_PROXY_HOP_COUNT', 1);
}

const TRUSTED_PROXY_ENV = 'FLOOM_TRUSTED_PROXY_CIDRS';
const LOOPBACK_PROXY_RULES = ['127.0.0.0/8', '::1/128'];
const DEV_PROXY_RULES = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', 'fc00::/7'];

interface SocketLike {
  remoteAddress?: string;
}

interface HttpBindingsLike {
  incoming?: {
    socket?: SocketLike;
  };
}

interface TrustedProxyMatcherCache {
  envRaw: string;
  nodeEnv: string | undefined;
  matcher: BlockList;
}

let trustedProxyMatcherCache: TrustedProxyMatcherCache | null = null;

function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (!value) return null;
  if (value.startsWith('[') && value.endsWith(']')) {
    value = value.slice(1, -1);
  }
  const zoneIndex = value.indexOf('%');
  if (zoneIndex >= 0) value = value.slice(0, zoneIndex);
  return isIP(value) ? value.toLowerCase() : null;
}

function addTrustedProxyRule(matcher: BlockList, rawRule: string): boolean {
  const rule = rawRule.trim();
  if (!rule) return false;

  const slash = rule.indexOf('/');
  if (slash === -1) {
    const ip = normalizeIp(rule);
    if (!ip) return false;
    matcher.addAddress(ip, isIP(ip) === 6 ? 'ipv6' : 'ipv4');
    return true;
  }

  const ip = normalizeIp(rule.slice(0, slash));
  const prefix = Number(rule.slice(slash + 1));
  if (!ip || !Number.isInteger(prefix)) return false;

  const family = isIP(ip);
  const maxPrefix = family === 6 ? 128 : 32;
  if (prefix < 0 || prefix > maxPrefix) return false;

  matcher.addSubnet(ip, prefix, family === 6 ? 'ipv6' : 'ipv4');
  return true;
}

function buildTrustedProxyMatcher(): BlockList {
  const matcher = new BlockList();
  const configured = (process.env[TRUSTED_PROXY_ENV] || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  const defaults =
    process.env.NODE_ENV === 'production'
      ? LOOPBACK_PROXY_RULES
      : [...LOOPBACK_PROXY_RULES, ...DEV_PROXY_RULES];
  const rules = configured.length > 0 ? [...LOOPBACK_PROXY_RULES, ...configured] : defaults;

  for (const rule of rules) {
    if (!addTrustedProxyRule(matcher, rule)) {
      console.warn(`[client-ip] ignoring invalid ${TRUSTED_PROXY_ENV} entry: ${rule}`);
    }
  }

  return matcher;
}

function getTrustedProxyMatcher(): BlockList {
  const envRaw = process.env[TRUSTED_PROXY_ENV] || '';
  const nodeEnv = process.env.NODE_ENV;
  if (
    trustedProxyMatcherCache &&
    trustedProxyMatcherCache.envRaw === envRaw &&
    trustedProxyMatcherCache.nodeEnv === nodeEnv
  ) {
    return trustedProxyMatcherCache.matcher;
  }

  const matcher = buildTrustedProxyMatcher();
  trustedProxyMatcherCache = { envRaw, nodeEnv, matcher };
  return matcher;
}

function extractPeerIp(c: Context): string | null {
  const env = (c as { env?: HttpBindingsLike & { server?: HttpBindingsLike } }).env;
  const bindings = env?.server ?? env;
  return normalizeIp(bindings?.incoming?.socket?.remoteAddress);
}

function parseForwardedIp(c: Context): string | null {
  const cf = normalizeIp(c.req.header('cf-connecting-ip'));
  if (cf) return cf;

  const real = normalizeIp(c.req.header('x-real-ip'));
  if (real) return real;

  const xff = c.req.header('x-forwarded-for');
  if (xff?.length) {
    const entries = xff
      .split(',')
      .map((part) => normalizeIp(part))
      .filter((part): part is string => !!part);
    if (entries.length > 0) {
      const hops = Math.max(1, defaultTrustedProxyHopCount());
      const idx = entries.length - hops;
      if (idx >= 0) return entries[idx] ?? null;
    }
  }
  return null;
}

function isTrustedProxyPeer(ip: string | null): boolean {
  if (!ip) return false;
  const family = isIP(ip);
  if (family === 0) return false;
  return getTrustedProxyMatcher().check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/**
 * Caller IP: use forwarded headers only when the peer socket address is a
 * trusted proxy; otherwise fall back to the direct peer IP.
 */
export function extractIp(c: Context): string {
  const peerIp = extractPeerIp(c);
  if (isTrustedProxyPeer(peerIp)) {
    const forwardedIp = parseForwardedIp(c);
    if (forwardedIp) return forwardedIp;
  }
  return peerIp || 'unknown';
}
