import type Docker from 'dockerode';
import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { hostname } from 'node:os';
import { domainToASCII } from 'node:url';
import type { NormalizedManifest } from '../types.js';
import { ManifestError } from './manifest.js';

export const LEGACY_DEFAULT_ALLOWED_DOMAINS = [
  'api.openai.com',
  'generativelanguage.googleapis.com',
  'api.anthropic.com',
] as const;

export const MAX_ALLOWED_DOMAINS = 20;

export interface NetworkPolicyConfig {
  allowed_domains: string[];
}

export interface PreparedNetworkPolicy {
  networkMode: string;
  env: string[];
  cleanup: () => Promise<void>;
}

function normalizeHostname(input: string): string {
  const trimmed = input.trim().toLowerCase();
  const ascii = domainToASCII(trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed);
  return ascii;
}

function isValidDomainName(hostname: string): boolean {
  if (hostname.length < 1 || hostname.length > 253) return false;
  if (hostname.includes('..')) return false;
  const labels = hostname.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => {
    if (label.length < 1 || label.length > 63) return false;
    if (label.startsWith('-') || label.endsWith('-')) return false;
    return /^[a-z0-9-]+$/.test(label);
  });
}

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const value = Number(part);
    if (value < 0 || value > 255) return null;
    n = (n << 8) + value;
  }
  return n >>> 0;
}

export function isPrivateOrLocalIp(address: string): boolean {
  const version = net.isIP(address);
  if (version === 4) {
    const n = ipv4ToNumber(address);
    if (n === null) return true;
    const inRange = (base: string, bits: number) => {
      const b = ipv4ToNumber(base);
      if (b === null) return false;
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return (n & mask) === (b & mask);
    };
    return (
      inRange('0.0.0.0', 8) ||
      inRange('10.0.0.0', 8) ||
      inRange('127.0.0.0', 8) ||
      inRange('169.254.0.0', 16) ||
      inRange('172.16.0.0', 12) ||
      inRange('192.168.0.0', 16)
    );
  }
  if (version === 6) {
    const normalized = address.toLowerCase();
    if (normalized === '::1' || normalized === '::') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(normalized)) return true;
    if (normalized.startsWith('::ffff:')) {
      const mapped = normalized.slice('::ffff:'.length);
      return net.isIP(mapped) === 4 ? isPrivateOrLocalIp(mapped) : true;
    }
    return false;
  }
  return false;
}

export function normalizeAllowedDomain(entry: string, field: string): string {
  const normalized = normalizeHostname(entry);
  if (normalized === '*') {
    throw new ManifestError(`${field} cannot be "*"`, field);
  }
  if (normalized.includes('/') || normalized.includes(':') || normalized.includes('@')) {
    throw new ManifestError(
      `${field} must be a domain name or "*.domain" glob, not a URL or host:port`,
      field,
    );
  }
  if (net.isIP(normalized) !== 0) {
    throw new ManifestError(`${field} must be a domain name, not an IP address`, field);
  }
  if (normalized.startsWith('*.')) {
    const suffix = normalized.slice(2);
    if (!isValidDomainName(suffix)) {
      throw new ManifestError(`${field} has invalid wildcard domain "${entry}"`, field);
    }
    return `*.${suffix}`;
  }
  if (normalized.includes('*')) {
    throw new ManifestError(`${field} wildcard must use the "*.domain" form`, field);
  }
  if (!isValidDomainName(normalized)) {
    throw new ManifestError(`${field} has invalid domain "${entry}"`, field);
  }
  return normalized;
}

export function validateNetworkPolicy(raw: unknown, field = 'network'): NetworkPolicyConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ManifestError(`${field} must be an object`, field);
  }
  const obj = raw as Record<string, unknown>;
  const allowed = obj.allowed_domains;
  if (allowed === undefined) {
    return { allowed_domains: [] };
  }
  if (!Array.isArray(allowed) || allowed.some((v) => typeof v !== 'string')) {
    throw new ManifestError(`${field}.allowed_domains must be an array of strings`, `${field}.allowed_domains`);
  }
  if (allowed.length > MAX_ALLOWED_DOMAINS) {
    throw new ManifestError(
      `${field}.allowed_domains can contain at most ${MAX_ALLOWED_DOMAINS} domains`,
      `${field}.allowed_domains`,
    );
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  allowed.forEach((entry, i) => {
    const domain = normalizeAllowedDomain(entry, `${field}.allowed_domains[${i}]`);
    if (!seen.has(domain)) {
      seen.add(domain);
      normalized.push(domain);
    }
  });
  return { allowed_domains: normalized };
}

export function getEffectiveAllowedDomains(manifest: NormalizedManifest | undefined | null): string[] {
  // Defensive guard: callers like runAppContainer in some test paths
  // (test-file-inputs-docker.mjs) invoke without a manifest. Treat
  // missing-manifest as legacy default — same behavior as legacy apps
  // that pre-date the network.allowed_domains field.
  if (!manifest) {
    return [...LEGACY_DEFAULT_ALLOWED_DOMAINS];
  }
  if (manifest.network && Array.isArray(manifest.network.allowed_domains)) {
    return manifest.network.allowed_domains;
  }
  return [...LEGACY_DEFAULT_ALLOWED_DOMAINS];
}

function matchesAllowedDomain(hostname: string, allowedDomains: string[]): boolean {
  const host = normalizeHostname(hostname);
  return allowedDomains.some((allowed) => {
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(2);
      return host !== suffix && host.endsWith(`.${suffix}`);
    }
    return host === allowed;
  });
}

async function resolvePublicAddresses(hostname: string): Promise<Array<{ address: string; family: 4 | 6 }>> {
  const records = await lookup(hostname, { all: true, verbatim: false });
  const publicRecords = records.filter((record) => !isPrivateOrLocalIp(record.address));
  if (records.length === 0 || publicRecords.length !== records.length) {
    throw new Error('target resolved to a private or local address');
  }
  return publicRecords as Array<{ address: string; family: 4 | 6 }>;
}

function parseConnectTarget(raw: string | undefined): { hostname: string; port: number } | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf(':');
  if (idx <= 0) return null;
  const hostname = raw.slice(0, idx);
  const port = Number(raw.slice(idx + 1));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { hostname, port };
}

function deny(runId: string, host: string, reason: string): void {
  console.warn(`[network-policy] denied outbound run=${runId} host=${host} reason=${reason}`);
}

async function authorizeTarget(
  runId: string,
  hostname: string,
  allowedDomains: string[],
): Promise<{ ok: true; addresses: Array<{ address: string; family: 4 | 6 }> } | { ok: false; reason: string }> {
  const normalized = normalizeHostname(hostname);
  if (!normalized || net.isIP(normalized) !== 0) {
    deny(runId, hostname, 'ip_literal_or_invalid_host');
    return { ok: false, reason: 'IP literals and invalid hosts are blocked' };
  }
  if (!matchesAllowedDomain(normalized, allowedDomains)) {
    deny(runId, normalized, 'domain_not_allowlisted');
    return { ok: false, reason: `${normalized} is not in network.allowed_domains` };
  }
  try {
    return { ok: true, addresses: await resolvePublicAddresses(normalized) };
  } catch (err) {
    const reason = (err as Error).message || 'DNS resolution failed';
    deny(runId, normalized, reason);
    return { ok: false, reason };
  }
}

async function startAllowlistProxy(
  runId: string,
  bindHost: string,
  advertisedHost: string,
  allowedDomains: string[],
): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer(async (req, res) => {
    let target: URL;
    try {
      target = new URL(req.url || '');
    } catch {
      res.writeHead(400);
      res.end('Proxy requests must use an absolute URL');
      return;
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      res.writeHead(403);
      res.end('Protocol blocked by Floom network policy');
      return;
    }
    const auth = await authorizeTarget(runId, target.hostname, allowedDomains);
    if (!auth.ok) {
      res.writeHead(403);
      res.end(`Blocked by Floom network policy: ${auth.reason}`);
      return;
    }
    const address = auth.addresses[0];
    const client = (target.protocol === 'https:' ? https : http).request(
      {
        protocol: target.protocol,
        host: address.address,
        family: address.family,
        port: target.port ? Number(target.port) : target.protocol === 'https:' ? 443 : 80,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: { ...req.headers, host: target.host },
        servername: target.hostname,
      },
      (upstream) => {
        res.writeHead(upstream.statusCode || 502, upstream.headers);
        upstream.pipe(res);
      },
    );
    client.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502);
      res.end(`Proxy upstream error: ${(err as Error).message}`);
    });
    req.pipe(client);
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.unref();
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {
      // Per-run proxy sockets are best-effort plumbing; the app sees the
      // request failure through curl/fetch and the deny path logs separately.
    });
  });

  server.on('connect', async (req, clientSocket, head) => {
    clientSocket.on('error', () => {
      // The app process may close the tunnel immediately after a deny or
      // timeout. That is already represented by the HTTP status we sent.
    });
    const target = parseConnectTarget(req.url);
    if (!target) {
      clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    const auth = await authorizeTarget(runId, target.hostname, allowedDomains);
    if (!auth.ok) {
      clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\nBlocked by Floom network policy');
      return;
    }
    const address = auth.addresses[0];
    const upstream = net.connect({
      host: address.address,
      family: address.family,
      port: target.port,
    });
    upstream.unref();
    upstream.on('error', (err) => {
      deny(runId, target.hostname, (err as Error).message || 'connect_failed');
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    upstream.on('connect', () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
  });

  const address = await new Promise<net.AddressInfo>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, bindHost, () => {
      server.off('error', reject);
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('proxy did not bind to a TCP address'));
        return;
      }
      resolve(addr);
    });
  });
  server.unref();

  return {
    url: `http://${advertisedHost}:${address.port}`,
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
        const timer = setTimeout(resolve, 1_000);
        server.close((err) => {
          clearTimeout(timer);
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

function getNetworkContainerIp(
  networkInfo: { Containers?: Record<string, { Name?: string; IPv4Address?: string }> },
  containerId: string,
): string | null {
  const containers = networkInfo.Containers || {};
  for (const [id, details] of Object.entries(containers)) {
    const name = (details.Name || '').replace(/^\//, '');
    if (id === containerId || id.startsWith(containerId) || name === containerId) {
      const ip = details.IPv4Address?.split('/')[0];
      if (ip && net.isIP(ip) === 4) return ip;
    }
  }
  return null;
}

async function connectCurrentContainerToNetwork(
  network: Docker.Network,
): Promise<{ containerId: string; ip: string; cleanup: () => Promise<void> }> {
  const containerId = hostname();
  if (!containerId) {
    throw new Error('current container hostname is empty');
  }

  await network.connect({ Container: containerId });
  const info = await network.inspect();
  const ip = getNetworkContainerIp(info, containerId);
  if (!ip) {
    await network.disconnect({ Container: containerId, Force: true }).catch(() => {});
    throw new Error(`Docker network did not expose an IP for current container ${containerId}`);
  }

  return {
    containerId,
    ip,
    cleanup: async () => {
      await network.disconnect({ Container: containerId, Force: true });
    },
  };
}

export async function prepareDockerNetworkPolicy(
  docker: Docker,
  runId: string,
  manifest: NormalizedManifest,
): Promise<PreparedNetworkPolicy> {
  const allowedDomains = getEffectiveAllowedDomains(manifest);
  if (allowedDomains.length === 0) {
    return {
      networkMode: 'none',
      env: [],
      cleanup: async () => {},
    };
  }

  const networkName = `floom-run-net-${runId.replace(/[^a-zA-Z0-9_.-]/g, '').slice(0, 48)}`;
  let network: Docker.Network | null = null;
  let proxy: { url: string; close: () => Promise<void> } | null = null;
  let currentContainerNetwork: { ip: string; cleanup: () => Promise<void> } | null = null;
  try {
    network = await docker.createNetwork({
      Name: networkName,
      Driver: 'bridge',
      Internal: true,
      CheckDuplicate: true,
    });
    const info = await network.inspect();
    const gateway = info.IPAM?.Config?.find((cfg: { Gateway?: string }) => cfg.Gateway)?.Gateway;
    if (!gateway) {
      throw new Error(`Docker network ${networkName} did not expose a gateway`);
    }

    try {
      proxy = await startAllowlistProxy(runId, gateway, gateway, allowedDomains);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EADDRNOTAVAIL') {
        throw err;
      }
      currentContainerNetwork = await connectCurrentContainerToNetwork(network);
      proxy = await startAllowlistProxy(
        runId,
        '0.0.0.0',
        currentContainerNetwork.ip,
        allowedDomains,
      );
    }

    const proxyUrl = proxy.url;
    return {
      networkMode: networkName,
      env: [
        `HTTP_PROXY=${proxyUrl}`,
        `HTTPS_PROXY=${proxyUrl}`,
        `ALL_PROXY=${proxyUrl}`,
        `http_proxy=${proxyUrl}`,
        `https_proxy=${proxyUrl}`,
        `all_proxy=${proxyUrl}`,
        `NO_PROXY=localhost,127.0.0.1,::1,169.254.169.254,metadata.google.internal`,
        `no_proxy=localhost,127.0.0.1,::1,169.254.169.254,metadata.google.internal`,
      ],
      cleanup: async () => {
        const errors: string[] = [];
        if (proxy) {
          try {
            await proxy.close();
          } catch (err) {
            errors.push((err as Error).message);
          }
        }
        if (currentContainerNetwork) {
          try {
            await currentContainerNetwork.cleanup();
          } catch (err) {
            errors.push((err as Error).message);
          }
        }
        if (network) {
          try {
            await network.remove();
          } catch (err) {
            errors.push((err as Error).message);
          }
        }
        if (errors.length > 0) {
          console.warn(`[network-policy] cleanup run=${runId} errors=${errors.join('; ')}`);
        }
      },
    };
  } catch (err) {
    if (proxy) await proxy.close().catch(() => {});
    if (currentContainerNetwork) await currentContainerNetwork.cleanup().catch(() => {});
    if (network) await network.remove().catch(() => {});
    throw err;
  }
}
