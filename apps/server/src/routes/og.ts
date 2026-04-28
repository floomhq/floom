// GET /og/:slug.svg — dynamic social preview image for /p/:slug.
//
// Produces a 1200x630 SVG with:
//   - Floom wordmark top-left
//   - App name (large, bold)
//   - App description (up to 2 lines)
//   - Sample output card — curated per slug, or generic bullets
//   - "run it on floom.dev/p/<slug>" footer
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
  return t.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

// Curated sample outputs per well-known app slug. Each entry has a
// "score" label and up to 3 bullet lines that simulate real output,
// giving previewers something concrete to intrigue the viewer.
//
// Falls back to generic bullets if slug not found.
const CURATED_SAMPLES: Record<string, { score: string; bullets: string[] }> = {
  'ai-readiness-audit': {
    score: 'Score: 8/10',
    bullets: [
      'Clear positioning and concrete use-case',
      'Missing customer proof points',
      'Add one quantified case study to unlock 9/10',
    ],
  },
  'lead-scorer': {
    score: '3 leads ranked',
    bullets: [
      'Acme Corp — 92/100 (budget confirmed, timeline Q3)',
      'BetaCo — 67/100 (interest high, decision slow)',
      'GammaTech — 41/100 (no budget signal)',
    ],
  },
  'resume-screener': {
    score: '5 resumes screened',
    bullets: [
      'Alice M. — Strong match (Python, 4y exp, ML background)',
      'Bob K. — Partial match (React focus, no backend)',
      'Carol D. — Weak match (entry-level, no relevant projects)',
    ],
  },
  'competitor-analyzer': {
    score: '3 gaps found',
    bullets: [
      'Pricing: competitor A is 30% cheaper on starter tier',
      'Feature gap: no mobile app (both rivals have one)',
      'Opportunity: only you offer an API — highlight it',
    ],
  },
};

interface OgCopy {
  title: string;
  description: string;
  author: string | null;
  slug: string;
}

// Wrap description text into lines of at most maxChars per line.
function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= maxChars) {
      current += ' ' + word;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines.slice(0, 2); // at most 2 description lines
}

function renderSvg(copy: OgCopy): string {
  const title = escapeXml(truncate(copy.title, 44));
  const rawDesc = truncate(copy.description || 'Run this AI app on Floom.', 160);
  const descLines = wrapText(rawDesc, 68);
  const author = copy.author ? escapeXml(`by @${copy.author.replace(/^@/, '')}`) : '';

  // Color palette matches current Floom brand: deep ink on near-white,
  // emerald accent. Typography uses system stack so the SVG renders
  // consistently across previewers that strip <font-face>.
  const ink = '#0e0e0c';
  const muted = '#585550';
  const accent = '#047857';
  const bg = '#FAFAF7';
  const line = '#e8e6e0';
  const cardBg = '#F0EFE9';

  // Curated sample output, or a generic "Try it" card.
  const sample = CURATED_SAMPLES[copy.slug];
  const scoreLabel = sample ? escapeXml(sample.score) : escapeXml('Try it on Floom');
  const bulletLines = sample
    ? sample.bullets.slice(0, 3).map((b) => escapeXml(truncate(b, 60)))
    : [
        escapeXml(truncate(copy.description || 'Run AI tasks in seconds.', 60)),
        escapeXml('Powered by Floom — the AI app runtime.'),
        escapeXml('Free to run. No account required.'),
      ];

  // Vertical layout
  const descY1 = 310;
  const descY2 = descY1 + 38;
  const cardTop = descLines.length > 1 ? 376 : 338;
  const cardPad = 22;
  const cardWidth = WIDTH - 160;
  const cardHeight = bulletLines.length * 34 + cardPad * 2 + 26;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="accentGrad" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="${accent}"/>
      <stop offset="100%" stop-color="#059669"/>
    </linearGradient>
  </defs>

  <!-- Background -->
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${bg}"/>

  <!-- Top accent bar -->
  <rect x="0" y="0" width="${WIDTH}" height="5" fill="url(#accentGrad)"/>

  <!-- Floom wordmark — two stacked bars + name -->
  <g transform="translate(80, 48)">
    <rect x="0" y="0" width="9" height="28" rx="2.5" fill="${accent}"/>
    <rect x="14" y="0" width="9" height="20" rx="2.5" fill="${accent}" opacity="0.5"/>
    <text x="36" y="22" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="22" fill="${ink}" letter-spacing="-0.5">floom</text>
  </g>

  <!-- Subtle divider below wordmark -->
  <line x1="80" y1="94" x2="${WIDTH - 80}" y2="94" stroke="${line}" stroke-width="1"/>

  <!-- App title -->
  <text x="80" y="228" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-weight="800" font-size="76" letter-spacing="-2" fill="${ink}">${title}</text>

  <!-- Description lines -->
  <text x="80" y="${descY1}" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-size="27" fill="${muted}">${escapeXml(descLines[0] ?? '')}</text>
  ${descLines[1] ? `<text x="80" y="${descY2}" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-size="27" fill="${muted}">${escapeXml(descLines[1])}</text>` : ''}

  <!-- Sample output card -->
  <rect x="80" y="${cardTop}" width="${cardWidth}" height="${cardHeight}" rx="10" fill="${cardBg}" stroke="${line}" stroke-width="1.5"/>

  <!-- Score / label in accent -->
  <text x="${80 + cardPad}" y="${cardTop + cardPad + 14}" font-family="'JetBrains Mono', Menlo, monospace" font-size="16" font-weight="700" fill="${accent}">${scoreLabel}</text>

  <!-- Divider inside card -->
  <line x1="${80 + cardPad}" y1="${cardTop + cardPad + 24}" x2="${80 + cardWidth - cardPad}" y2="${cardTop + cardPad + 24}" stroke="${line}" stroke-width="1"/>

  <!-- Bullet lines -->
  ${bulletLines.map((b, i) => `<text x="${80 + cardPad}" y="${cardTop + cardPad + 52 + i * 34}" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-size="19" fill="${ink}">• ${b}</text>`).join('\n  ')}

  <!-- Footer -->
  <line x1="80" y1="${HEIGHT - 56}" x2="${WIDTH - 80}" y2="${HEIGHT - 56}" stroke="${line}" stroke-width="1"/>
  <g transform="translate(80, ${HEIGHT - 32})">
    ${author ? `<text x="0" y="0" font-family="'JetBrains Mono', Menlo, monospace" font-size="16" fill="${muted}">${author}</text>` : ''}
    <text x="${WIDTH - 160}" y="0" font-family="'JetBrains Mono', Menlo, monospace" font-size="16" fill="${accent}" font-weight="600" text-anchor="end">run it on floom.dev/p/${escapeXml(copy.slug)}</text>
  </g>
</svg>`;
}

function renderMainSvg(): string {
  // Tokens mirror the v17 landing palette (/apps/web/public/_landing.css):
  // bg #fafaf8, ink #0e0e0c, muted #585550, accent emerald-700 #047857.
  // Keep in sync with /apps/web/public/og-main-template.svg.
  const ink = '#0e0e0c';
  const muted = '#585550';
  const accent = '#047857';
  const bg = '#fafaf8';
  const line = '#e8e6e0';

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="accent" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#059669" stop-opacity="1"/>
      <stop offset="100%" stop-color="#10b981" stop-opacity="1"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="${bg}"/>
  <g stroke="${line}" stroke-width="1">
    <line x1="0" y1="170" x2="${WIDTH}" y2="170"/>
    <line x1="0" y1="500" x2="${WIDTH}" y2="500"/>
  </g>
  <g transform="translate(80,90)">
    <g transform="translate(0,0) scale(0.92)">
      <path d="M8 2 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z" fill="url(#accent)"/>
    </g>
    <text x="72" y="40" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-weight="700" font-size="36" fill="${ink}">Floom</text>
  </g>
  <text x="80" y="330" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-weight="800" font-size="96" letter-spacing="-3" fill="${ink}">Ship AI apps fast.</text>
  <text x="80" y="400" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-size="30" fill="${muted}">The protocol + runtime for agentic work.</text>
  <text x="80" y="455" font-family="'JetBrains Mono', 'Menlo', monospace" font-size="20" fill="${accent}" font-weight="600">Vibe-coding speed. Production-grade safety.</text>
  <text x="80" y="548" font-family="'JetBrains Mono', 'Menlo', monospace" font-size="14" fill="${muted}" letter-spacing="2" font-weight="600">WORKS WITH</text>
  <g transform="translate(80, 568) scale(1.5)" fill="${ink}">
    <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z"/>
  </g>
  <text x="130" y="591" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-size="18" fill="${ink}" font-weight="500">Claude</text>
  <g transform="translate(260, 568) scale(1.5)" fill="${ink}">
    <path d="M11.503.131 1.891 5.678a.84.84 0 0 0-.42.726v11.188c0 .3.162.575.42.724l9.609 5.55a1 1 0 0 0 .998 0l9.61-5.55a.84.84 0 0 0 .42-.724V6.404a.84.84 0 0 0-.42-.726L12.497.131a1.01 1.01 0 0 0-.996 0M2.657 6.338h18.55c.263 0 .43.287.297.515L12.23 22.918c-.062.107-.229.064-.229-.06V12.335a.59.59 0 0 0-.295-.51l-9.11-5.257c-.109-.063-.064-.23.061-.23"/>
  </g>
  <text x="310" y="591" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-size="18" fill="${ink}" font-weight="500">Cursor</text>
  <g transform="translate(436, 568) scale(0.1406)" fill="${ink}">
    <path d="M239.184 106.203a64.716 64.716 0 0 0-5.576-53.103C219.452 28.459 191 15.784 163.213 21.74A65.586 65.586 0 0 0 52.096 45.22a64.716 64.716 0 0 0-43.23 31.36c-14.31 24.602-11.061 55.634 8.033 76.74a64.665 64.665 0 0 0 5.525 53.102c14.174 24.65 42.644 37.324 70.446 31.36a64.72 64.72 0 0 0 48.754 21.744c28.481.025 53.714-18.361 62.414-45.481a64.767 64.767 0 0 0 43.229-31.36c14.137-24.558 10.875-55.423-8.083-76.483Zm-97.56 136.338a48.397 48.397 0 0 1-31.105-11.255l1.535-.87 51.67-29.825a8.595 8.595 0 0 0 4.247-7.367v-72.85l21.845 12.636c.218.111.37.32.409.563v60.367c-.056 26.818-21.783 48.545-48.601 48.601Zm-104.466-44.61a48.345 48.345 0 0 1-5.781-32.589l1.534.921 51.722 29.826a8.339 8.339 0 0 0 8.441 0l63.181-36.425v25.221a.87.87 0 0 1-.358.665l-52.335 30.184c-23.257 13.398-52.97 5.431-66.404-17.803ZM23.549 85.38a48.499 48.499 0 0 1 25.58-21.333v61.39a8.288 8.288 0 0 0 4.195 7.316l62.874 36.272-21.845 12.636a.819.819 0 0 1-.767 0L41.353 151.53c-23.211-13.454-31.171-43.144-17.804-66.405v.256Zm179.466 41.695-63.08-36.63L161.73 77.86a.819.819 0 0 1 .768 0l52.233 30.184a48.6 48.6 0 0 1-7.316 87.635v-61.391a8.544 8.544 0 0 0-4.4-7.213Zm21.742-32.69-1.535-.922-51.619-30.081a8.39 8.39 0 0 0-8.492 0L99.98 99.808V74.587a.716.716 0 0 1 .307-.665l52.233-30.133a48.652 48.652 0 0 1 72.236 50.391v.205ZM88.061 139.097l-21.845-12.585a.87.87 0 0 1-.41-.614V65.685a48.652 48.652 0 0 1 79.757-37.346l-1.535.87-51.67 29.825a8.595 8.595 0 0 0-4.246 7.367l-.051 72.697Zm11.868-25.58 28.138-16.217 28.188 16.218v32.434l-28.086 16.218-28.188-16.218-.052-32.434Z"/>
  </g>
  <text x="486" y="591" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-size="18" fill="${ink}" font-weight="500">ChatGPT</text>
  <text x="630" y="591" font-family="'JetBrains Mono', 'Menlo', monospace" font-size="18" fill="${ink}" font-weight="500">Codex CLI</text>
  <text x="780" y="591" font-family="Inter, 'Helvetica Neue', Arial, sans-serif" font-size="18" fill="${muted}" font-weight="500">Any MCP client</text>
  <text x="${WIDTH - 80}" y="591" font-family="'JetBrains Mono', 'Menlo', monospace" font-size="18" fill="${muted}" text-anchor="end">floom.dev</text>
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
      slug,
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
      slug,
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
