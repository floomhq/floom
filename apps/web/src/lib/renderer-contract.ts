// Parent <-> iframe message contract for custom renderers.
//
// Custom renderer bundles run inside a sandboxed iframe (see
// apps/server/src/routes/renderer.ts). This module defines the exact set
// of messages that flow across the postMessage boundary. Anything else is
// silently dropped by the parent.
//
// Direction:
//   parent → iframe:   INIT          { type, output, status, app_slug }
//   iframe → parent:   READY         { type, slug }
//                      RENDERED      { type, slug, height }
//                      LINK_CLICK    { type, slug, href }
//
// Both sides validate the shape on every message. The parent additionally
// validates the `MessageEvent.source` is the iframe's `contentWindow` before
// acting, so a rogue other-tab window can't drive a re-render.

export type RendererStatus = 'success' | 'error' | 'running';

export interface RendererInitMessage {
  type: 'init';
  output: unknown;
  status: RendererStatus;
  app_slug: string;
}

export interface RendererReadyMessage {
  type: 'ready';
  slug: string;
}

export interface RendererRenderedMessage {
  type: 'rendered';
  slug: string;
  height: number;
}

export interface RendererLinkClickMessage {
  type: 'link_click';
  slug: string;
  href: string;
}

export type RendererOutgoing = RendererInitMessage;
export type RendererIncoming =
  | RendererReadyMessage
  | RendererRenderedMessage
  | RendererLinkClickMessage;

/**
 * Whitelist of url schemes we accept from the iframe's `link_click` message.
 * The parent re-validates before opening a new tab — a rogue renderer must
 * not be able to use window.open on the parent with a `javascript:` URL.
 */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

export function isRendererIncoming(x: unknown): x is RendererIncoming {
  if (!x || typeof x !== 'object') return false;
  const r = x as Record<string, unknown>;
  if (typeof r.type !== 'string') return false;
  if (r.type === 'ready') return typeof r.slug === 'string';
  if (r.type === 'rendered') {
    return (
      typeof r.slug === 'string' &&
      typeof r.height === 'number' &&
      Number.isFinite(r.height) &&
      r.height >= 0 &&
      r.height < 1_000_000
    );
  }
  if (r.type === 'link_click') {
    return typeof r.slug === 'string' && typeof r.href === 'string';
  }
  return false;
}

export function isSafeLinkHref(href: string): boolean {
  try {
    const u = new URL(href);
    return SAFE_SCHEMES.has(u.protocol);
  } catch {
    return false;
  }
}

/** Clamp iframe height to a sane range so a broken / malicious renderer
 * can't push the page to 10^9 pixels. */
export function clampIframeHeight(h: number): number {
  if (!Number.isFinite(h) || h < 0) return 0;
  if (h > 10_000) return 10_000;
  return Math.ceil(h);
}
