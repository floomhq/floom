// Inline SVG sprite: every icon in one hidden <svg>, used via <use href="#id"/>.
// Ported verbatim from the wireframes' icons.js.
export function IconSprite() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" style={{ display: 'none' }} aria-hidden="true">
      {/* Brand logos */}
      <symbol id="icon-anthropic" viewBox="0 0 24 24">
        <path
          fill="currentColor"
          d="M13.827 3.678l5.927 16.256H24L17.927 3.678h-4.1zM6.154 3.678L0 20.066h4.246l1.213-3.478h6.395l1.213 3.478h4.246L11.159 3.678h-5.005zm.521 9.69l2.002-5.74 2.001 5.74H6.675z"
        />
      </symbol>
      <symbol id="icon-cursor" viewBox="0 0 24 24">
        <path
          fill="currentColor"
          d="M12 0L1.605 6v12L12 24l10.395-6V6L12 0zm0 2.18l8.395 4.847v9.946L12 21.82l-8.395-4.847V7.027L12 2.18zm0 3.328L5.607 9.36v5.28L12 18.492l6.393-3.852V9.36L12 5.508zm0 2.18l4.186 2.521V13.8L12 16.32l-4.186-2.52v-2.59L12 8.688z"
        />
      </symbol>
      <symbol id="icon-windsurf" viewBox="0 0 24 24">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M2 6l3.5 12L9 10l3 8 3-8 3.5 8L22 6"
        />
      </symbol>
      <symbol id="icon-continue" viewBox="0 0 24 24">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 12h16m-6-6l6 6-6 6M4 7v10"
        />
      </symbol>
      <symbol id="icon-github" viewBox="0 0 24 24">
        <path
          fill="currentColor"
          d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"
        />
      </symbol>

      {/* App glyphs, Lucide style */}
      <symbol id="app-flyfast" viewBox="0 0 24 24">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21 3L3 10.5l7 2 2 7L21 3zM10 12.5l3.5-3.5"
        />
      </symbol>
      <symbol id="app-openslides" viewBox="0 0 24 24">
        <rect x="3" y="5" width="18" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="3" y="11" width="18" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="3" y="17" width="12" height="4" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="app-openblog" viewBox="0 0 24 24">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 20H5a2 2 0 01-2-2V6a2 2 0 012-2h9l5 5v9a2 2 0 01-2 2h-1"
        />
        <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M7 12h7M7 16h5" />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M14 4v5h5"
        />
      </symbol>
      <symbol id="app-opendraft" viewBox="0 0 24 24">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 3l7 4v5c0 4-3 7-7 9-4-2-7-5-7-9V7l7-4z"
        />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12l2 2 4-4"
        />
      </symbol>
      <symbol id="app-openanalytics" viewBox="0 0 24 24">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 20h18M7 20V14M11 20V9M15 20V12M19 20V5"
        />
      </symbol>
      <symbol id="app-opengtm" viewBox="0 0 24 24">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 11l19-9-9 19-2-8-8-2z"
        />
      </symbol>
      <symbol id="app-claudewrapped" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          d="M8 12c0-2.2 1.8-4 4-4s4 1.8 4 4M6 12c0-3.3 2.7-6 6-6s6 2.7 6 6"
        />
      </symbol>
      <symbol id="app-opencontext" viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" rx="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="7" y="7" width="10" height="10" rx="1" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <rect x="10" y="10" width="4" height="4" rx="0.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="app-openpaper" viewBox="0 0 24 24">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M6 2h9l4 4v14a2 2 0 01-2 2H6a2 2 0 01-2-2V4a2 2 0 012-2z"
        />
        <path fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" d="M14 2v5h5M8 13h8M8 17h5" />
      </symbol>
      <symbol id="app-blastradius" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </symbol>
      <symbol id="app-depcheck" viewBox="0 0 24 24">
        <circle cx="12" cy="5" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="5" cy="19" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="19" cy="19" r="2" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          d="M12 7v4M8.5 17.5L10 13M15.5 17.5L14 13M10 13h4"
        />
      </symbol>
      <symbol id="app-sessionrecall" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 7v5l3 3"
        />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 3l3.5 3.5"
        />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 8V3h5"
        />
      </symbol>
      <symbol id="app-hookstats" viewBox="0 0 24 24">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 3C9 3 7 5 7 7.5c0 2 1.5 3.5 3 4l1 7.5a1 1 0 002 0L14 17c2.5-1 4-3 4-5.5C18 8 16 5.5 12 3z"
        />
      </symbol>
      <symbol id="app-bouncer" viewBox="0 0 24 24">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M12 2l7 3.5v6c0 4.5-3 8.5-7 10-4-1.5-7-5.5-7-10V5.5L12 2z"
        />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M9 12l2 2 4-4"
        />
      </symbol>
      <symbol id="app-openkeyword" viewBox="0 0 24 24">
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          d="M4 9h16M4 15h16M10 3l-4 18M14 3l-4 18"
        />
      </symbol>

      {/* Fast-apps wave: seven deterministic utility apps.
          All glyphs follow the Lucide stroke style (1.5 width, round caps) so
          they sit next to the other app icons without visual drift. */}
      <symbol id="app-uuid" viewBox="0 0 24 24">
        {/* Lucide `fingerprint` outline: four concentric arcs evoking a
            hashable, random identifier. */}
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M6 11a6 6 0 0 1 9.5-4.85M8 13c0-2.2 1.8-4 4-4s4 1.8 4 4v1.5M12 13v4M7 17.5c.5-1 1-2 1-3.5M12 20c0-1.5 0-3 0-4M17 19c-.5-.5-1-1.5-1-3"
        />
      </symbol>
      <symbol id="app-password" viewBox="0 0 24 24">
        {/* Lucide `key-round` outline: a closed key shape. */}
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M21 2l-9.5 9.5M15.5 7.5l3 3M4 22a5 5 0 1 1 5-5 5 5 0 0 1-5 5zM4 17h.01"
        />
      </symbol>
      <symbol id="app-hash" viewBox="0 0 24 24">
        {/* Lucide `hash` outline. */}
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 9h16M4 15h16M10 3L8 21M16 3l-2 18"
        />
      </symbol>
      <symbol id="app-base64" viewBox="0 0 24 24">
        {/* Binary columns — eight small rectangles in two rows evoke a
            base64-encoded buffer. */}
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M4 6h4v5H4zM10 6h4v5h-4zM16 6h4v5h-4zM4 13h4v5H4zM10 13h4v5h-4zM16 13h4v5h-4z"
        />
      </symbol>
      <symbol id="app-json-format" viewBox="0 0 24 24">
        {/* Lucide `braces`: two curly brackets with a dot between. */}
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"
        />
      </symbol>
      <symbol id="app-jwt-decode" viewBox="0 0 24 24">
        {/* Lucide `scan-line` — scanning bracket over a line — evokes
            reading/inspecting a token without verifying it. */}
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 12h10"
        />
      </symbol>
      <symbol id="app-word-count" viewBox="0 0 24 24">
        {/* Lucide `text-quote` / align-left with a counter tick — words and
            lines stacked. */}
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M17 6.1H3M21 12.1H3M15.1 18H3"
        />
      </symbol>

      {/* Default fallback app icon */}
      <symbol id="app-default" viewBox="0 0 24 24">
        <rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" strokeWidth="1.5" />
        <path
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          d="M8 12h8M12 8v8"
        />
      </symbol>
    </svg>
  );
}

// Map a slug to the right icon id. Falls back to app-default.
export function iconForSlug(slug: string): string {
  const map: Record<string, string> = {
    flyfast: 'app-flyfast',
    openslides: 'app-openslides',
    openblog: 'app-openblog',
    opendraft: 'app-opendraft',
    openanalytics: 'app-openanalytics',
    opengtm: 'app-opengtm',
    'claude-wrapped': 'app-claudewrapped',
    opencontext: 'app-opencontext',
    openpaper: 'app-openpaper',
    'blast-radius': 'app-blastradius',
    'dep-check': 'app-depcheck',
    'session-recall': 'app-sessionrecall',
    'hook-stats': 'app-hookstats',
    bouncer: 'app-bouncer',
    openkeyword: 'app-openkeyword',
    // Fast-apps wave
    uuid: 'app-uuid',
    password: 'app-password',
    hash: 'app-hash',
    base64: 'app-base64',
    'json-format': 'app-json-format',
    'jwt-decode': 'app-jwt-decode',
    'word-count': 'app-word-count',
  };
  return map[slug] || 'app-default';
}
