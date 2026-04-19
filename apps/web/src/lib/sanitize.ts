// DOMPurify wrapper for HTML coming out of creator apps.
//
// Apps can legitimately return `type: "html"` outputs (e.g. a generated
// slide deck, a report, a rendered email preview). The runner embeds
// that HTML inline on the page via `dangerouslySetInnerHTML`, so a
// malicious or compromised creator could otherwise inject scripts into
// the Floom origin and steal the viewer's session.
//
// We sanitize with DOMPurify defaults plus a narrow allow-list for
// iframes (custom-renderer iframes are already sandboxed same-origin
// via `/renderer/:slug/frame.html` and served with their own CSP, so
// allowing them through sanitization is safe).
//
// Importantly, DOMPurify strips:
//   - <script>, inline event handlers (onclick=, onload=, etc.)
//   - `javascript:` URLs in href / src
//   - <meta http-equiv> redirects
//   - Form action exfiltration
//
// Usage:
//   <div dangerouslySetInnerHTML={{ __html: sanitizeHtml(untrusted) }} />

import DOMPurify, { type Config } from 'dompurify';

// Reusable config. `ADD_TAGS` / `ADD_ATTR` are intentionally empty — we
// trust DOMPurify's defaults. `USE_PROFILES: { html: true }` keeps SVG
// + MathML off by default; creator apps that need SVG should emit it as
// a PNG/SVG file download instead.
const PURIFY_CONFIG: Config = {
  USE_PROFILES: { html: true },
  // Block `<form>` to prevent credential exfiltration via form action.
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option'],
  // Return a plain string (not TrustedHTML) so the value is directly
  // assignable to `dangerouslySetInnerHTML.__html`.
  RETURN_TRUSTED_TYPE: false,
};

// Install a hook once to harden <a target="_blank">. DOMPurify keeps a
// singleton so this is idempotent under HMR.
//
// Guard the hook install with a `window` check: when RunSurface.tsx
// (which transitively imports this module) is imported under tsx for
// the stress tests, Node has no DOM and `DOMPurify.addHook` is
// undefined on the factory. We only need the hook in the browser
// anyway. See `apps/server/package.json` test script for the importers.
if (typeof window !== 'undefined' && typeof DOMPurify.addHook === 'function') {
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('target') === '_blank') {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/**
 * Sanitize an HTML string for safe inline rendering. Returns a string
 * suitable for `dangerouslySetInnerHTML={{ __html: ... }}`.
 *
 * The runner only renders HTML outputs client-side (there is no SSR in
 * @floom/web) so DOMPurify always has a real DOM. We keep a lightweight
 * `window` check so Vitest / jsdom-less unit tests returning the raw
 * string don't blow up.
 *
 * NOTE: Do not add `typeof DOMPurify.sanitize !== 'function'` guards
 * here. DOMPurify is imported eagerly at the top of this file; a
 * runtime type-check on its method confuses some tree-shakers (Rollup
 * has historically pruned eagerly-imported modules whose only observed
 * usage was a `typeof` check) and we want the library fully retained
 * in the production bundle. See PR #143.
 */
export function sanitizeHtml(html: string): string {
  if (typeof window === 'undefined') {
    return html;
  }
  // Cast to string: with RETURN_TRUSTED_TYPE:false the return is a plain
  // string, but the overload resolution still infers `TrustedHTML | string`.
  return DOMPurify.sanitize(html, PURIFY_CONFIG) as unknown as string;
}
