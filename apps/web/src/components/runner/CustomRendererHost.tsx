// W2.2 custom renderer host — embeds the creator's compiled bundle inside a
// sandboxed iframe served from `/renderer/:slug/frame.html`. Falls back to
// `children` (the default OutputPanel tree) if the frame fails to post
// `ready` within a short timeout, or if the run is not a successful one.
//
// Security model (sec/renderer-sandbox, 2026-04-17)
// ------------------------------------------------
// The old implementation used `lazy(() => import('/renderer/:slug/bundle.js'))`
// which executed the creator's code directly in the main window's JS context.
// That gave the bundle full access to `document.cookie`, `localStorage`,
// and `/api/me` (via relative fetch), which meant a malicious creator could
// exfiltrate any logged-in user's session.
//
// This version isolates the bundle by:
//   1. Loading it via `<iframe sandbox="allow-scripts">` (no
//      `allow-same-origin` → the iframe gets an opaque origin).
//   2. The iframe's host page (`frame.html`) ships with CSP
//      `connect-src 'none'`, so the bundle can't fetch any URL.
//   3. The only data flow is `postMessage` with a validated wire format
//      (see ../../lib/renderer-contract.ts).
//
// What the host does:
//   - Mounts an iframe pointing at `/renderer/:slug/frame.html?v=<hash>`.
//   - When the bundle posts `{type: 'ready'}` it sends down the run's
//     output via `postMessage({type: 'init', output, status, app_slug})`.
//   - On `{type: 'rendered', height}` it auto-grows the iframe.
//   - On `{type: 'link_click', href}` it opens the href in a new tab
//     after re-validating the URL scheme.
//   - Any other message is dropped silently.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { RunRecord } from '../../lib/types';
import {
  clampIframeHeight,
  isRendererIncoming,
  isSafeLinkHref,
  type RendererInitMessage,
} from '../../lib/renderer-contract';

interface Props {
  slug: string;
  run: RunRecord;
  sourceHash?: string | null;
  children: ReactNode;
}

const DEFAULT_HEIGHT = 240;
const READY_TIMEOUT_MS = 4000;

export function CustomRendererHost({
  slug,
  run,
  sourceHash,
  children,
}: Props) {
  const ok = run.status === 'success';
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [height, setHeight] = useState<number>(DEFAULT_HEIGHT);
  // `failed` true → bundle didn't post {ready} in time, or posted an
  // unparseable message. We fall back to `children`.
  const [failed, setFailed] = useState<boolean>(false);
  const [ready, setReady] = useState<boolean>(false);

  const frameUrl = useMemo(() => {
    const bust = sourceHash ? `?v=${encodeURIComponent(sourceHash)}` : '';
    return `/renderer/${encodeURIComponent(slug)}/frame.html${bust}`;
  }, [slug, sourceHash]);

  // Stable init payload. If run.outputs changes (re-run, iterate) the effect
  // below re-sends init. We stringify+parse first so any non-cloneable values
  // (functions, DOM nodes) are stripped before crossing the postMessage
  // structured-clone boundary.
  const initPayload = useMemo<RendererInitMessage>(
    () => ({
      type: 'init',
      output: JSON.parse(JSON.stringify(run.outputs ?? null)),
      status: run.status === 'success' ? 'success' : 'error',
      app_slug: slug,
    }),
    [run.outputs, run.status, slug],
  );

  useEffect(() => {
    if (!ok) return;
    // Reset state whenever the frame URL changes (slug / hash bust).
    setFailed(false);
    setReady(false);
    setHeight(DEFAULT_HEIGHT);

    const readyTimer = window.setTimeout(() => {
      setFailed(true);
    }, READY_TIMEOUT_MS);

    function onMessage(ev: MessageEvent) {
      // Only accept messages from the iframe's own contentWindow. A
      // different window (another tab, the parent itself) can't spoof a
      // re-render this way.
      if (!iframeRef.current || ev.source !== iframeRef.current.contentWindow) {
        return;
      }
      if (!isRendererIncoming(ev.data)) {
        // Unknown shape — drop silently.
        return;
      }
      const msg = ev.data;
      if (msg.slug !== slug) return;
      if (msg.type === 'ready') {
        window.clearTimeout(readyTimer);
        setReady(true);
        // Ship the init payload. postMessage targets the iframe's window
        // regardless of origin; the iframe script validates shape.
        iframeRef.current.contentWindow?.postMessage(initPayload, '*');
        return;
      }
      if (msg.type === 'rendered') {
        setHeight(clampIframeHeight(msg.height) || DEFAULT_HEIGHT);
        return;
      }
      if (msg.type === 'link_click') {
        if (isSafeLinkHref(msg.href)) {
          window.open(msg.href, '_blank', 'noopener,noreferrer');
        }
        return;
      }
    }

    window.addEventListener('message', onMessage);
    return () => {
      window.clearTimeout(readyTimer);
      window.removeEventListener('message', onMessage);
    };
  }, [ok, frameUrl, slug, initPayload]);

  // When the run data changes after `ready`, re-send init without waiting
  // for another `ready` (the iframe stays mounted across re-runs).
  useEffect(() => {
    if (ready && iframeRef.current?.contentWindow) {
      iframeRef.current.contentWindow.postMessage(initPayload, '*');
    }
  }, [ready, initPayload]);

  if (!ok || failed) return <>{children}</>;

  return (
    <iframe
      ref={iframeRef}
      src={frameUrl}
      title={`${slug} renderer`}
      // `allow-scripts` only: no allow-same-origin (opaque origin), no
      // allow-top-navigation (can't redirect parent), no allow-forms
      // (defense in depth — frame.html has no forms anyway).
      sandbox="allow-scripts"
      data-testid="custom-renderer-iframe"
      style={{
        width: '100%',
        border: '0',
        height: `${height}px`,
        background: 'transparent',
        display: 'block',
      }}
    />
  );
}
