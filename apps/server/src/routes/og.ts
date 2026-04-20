// GET /og/:slug.svg — dynamic social preview image for /p/:slug.
//
// Produces a 1200x630 SVG with:
//   - Floom wordmark + subtle green accent
//   - App name (large)
//   - App description (1 line, truncated)
//   - Author handle if present ("by @federicodeponte")
//
// Also exposes /og/main.svg — the Floom landing OG image.
//
// Served with Cache-Control: public, max-age=300 so crawlers hit the
// route but we can update the copy by deploying.
//
// SVG is used deliberately (no native image deps). Modern crawlers
// (Discord, Slack, OG parsers, most previewers) render SVG og:image.
import { Hono } from 'hono';
import { db } from '../db.js';
import type { AppRecord } from '../types.js';

export const ogRouter = new Hono();

const WIDTH = 1200;
const HEIGHT = 630;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '\u2026';
}

interface OgCopy {
  title: string;
  description: string;
  author: string | null;
}

function renderSvg(copy: OgCopy): string {
  const title = escapeXml(truncate(copy.title, 48));
  const description = escapeXml(truncate(copy.description || '', 110));
  const author = copy.author ? escapeXml(`by @${copy.author.replace(/^@/, '')}`) : '';

  // Color palette matches current Floom brand: deep ink on near-white,
  // emerald accent pennant. Typography uses system stack so the SVG
  // renders consistently across previewers that strip <font-face>.
  const ink = '#0B0F0E';
  const muted = '#5F6A6E';
  const accent = '#047857';
  const bg = '#FAFAF7';
  const line = '#E2E2DD';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${accent}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${bg}"/>
  <g stroke="${line}" stroke-width="1" opacity="0.65">
    <line x1="0" y1="180" x2="${WIDTH}" y2="180"/>
    <line x1="0" y1="${HEIGHT - 120}" x2="${WIDTH}" y2="${HEIGHT - 120}"/>
  </g>
  <g transform="translate(80,78)">
    <path d="M0 0 L44 0 L44 46 L22 34 L0 46 Z" fill="url(#accent)"/>
    <text x="64" y="32" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="30" fill="${ink}">Floom</text>
  </g>
  <text x="80" y="322" font-family="'DM Serif Display', Georgia, serif" font-size="84" fill="${ink}">${title}</text>
  <text x="80" y="400" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-size="28" fill="${muted}">${description}</text>
  <g transform="translate(80, ${HEIGHT - 60})">
    <text x="0" y="0" font-family="'JetBrains Mono', 'Menlo', monospace" font-size="20" fill="${ink}">${author}</text>
    <text x="${WIDTH - 160}" y="0" font-family="'JetBrains Mono', 'Menlo', monospace" font-size="18" fill="${muted}" text-anchor="end">floom.dev</text>
  </g>
</svg>`;
}

function renderMainSvg(): string {
  const ink = '#0B0F0E';
  const muted = '#5F6A6E';
  const accent = '#047857';
  const bg = '#FAFAF7';
  const line = '#E2E2DD';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${accent}" stop-opacity="1"/>
      <stop offset="100%" stop-color="${accent}" stop-opacity="0.55"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${bg}"/>
  <g stroke="${line}" stroke-width="1" opacity="0.6">
    <line x1="0" y1="200" x2="${WIDTH}" y2="200"/>
    <line x1="0" y1="${HEIGHT - 120}" x2="${WIDTH}" y2="${HEIGHT - 120}"/>
  </g>
  <g transform="translate(80,90)">
    <path d="M0 0 L52 0 L52 56 L26 42 L0 56 Z" fill="url(#accent)"/>
    <text x="72" y="40" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="36" fill="${ink}">Floom</text>
  </g>
  <text x="80" y="360" font-family="'DM Serif Display', Georgia, serif" font-size="96" fill="${ink}">Ship AI apps fast.</text>
  <text x="80" y="460" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-size="30" fill="${muted}">The protocol + runtime for agentic work.</text>
  <text x="80" y="${HEIGHT - 60}" font-family="'JetBrains Mono', 'Menlo', monospace" font-size="20" fill="${accent}" font-weight="600">Vibe-coding speed. Production-grade safety.</text>
  <text x="${WIDTH - 80}" y="${HEIGHT - 60}" font-family="'JetBrains Mono', 'Menlo', monospace" font-size="20" fill="${muted}" text-anchor="end">floom.dev</text>
</svg>`;
}

ogRouter.get('/main.svg', (_c) => {
  const svg = renderMainSvg();
  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
});

ogRouter.get('/:slugPng{[a-z0-9][a-z0-9-]*\\.svg}', (c) => {
  const param = c.req.param('slugPng');
  const slug = param.replace(/\.svg$/, '');

  const row = db
    .prepare(
      `SELECT apps.*, users.name AS author_name, users.email AS author_email
         FROM apps
         LEFT JOIN users ON apps.author = users.id
        WHERE apps.slug = ?`,
    )
    .get(slug) as
    | (AppRecord & { author_name: string | null; author_email: string | null })
    | undefined;

  let copy: OgCopy;
  if (!row) {
    // Fall back to generic Floom card so broken links still render something
    // sensible in previewers rather than a 404 image.
    copy = {
      title: 'Floom',
      description: 'Ship AI apps fast.',
      author: null,
    };
  } else {
    const authorRaw = row.author_name && String(row.author_name).trim()
      ? String(row.author_name).trim()
      : row.author_email && row.author_email.includes('@')
      ? row.author_email.split('@')[0] || null
      : null;
    copy = {
      title: row.name || row.slug,
      description: row.description || '',
      author: authorRaw,
    };
  }

  const svg = renderSvg(copy);
  return new Response(svg, {
    status: 200,
    headers: {
      'content-type': 'image/svg+xml; charset=utf-8',
      'cache-control': 'public, max-age=300',
    },
  });
});
