// Renders the three states of /me/api-keys for visual verification.
// Serves the built web bundle from dist/ and intercepts /auth/api-key/*,
// /api/session/me, /auth/sign-in/email so the page believes it's in cloud
// mode and authenticated.
//
// Outputs: empty.png, created.png, display-once.png in OUT_DIR.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, extname } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const DIST = join(ROOT, 'apps/web/dist');
const OUT_DIR =
  process.env.OUT_DIR ||
  '/var/www/wireframes-floom/screenshots/api-keys-ui-2026-04-22';

if (!existsSync(DIST)) {
  console.error('dist not found — build first: pnpm --filter web build');
  process.exit(1);
}

// Minimal static server that falls back to index.html (SPA).
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

const server = createServer((req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    // SPA fallback: any path without a file extension → index.html.
    if (!extname(path)) path = '/index.html';
    const full = join(DIST, path);
    if (!full.startsWith(DIST) || !existsSync(full)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = extname(full);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
    });
    res.end(readFileSync(full));
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const base = `http://localhost:${port}`;
console.log(`static server: ${base}`);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
});

// Seed auth cookie so PageShell's `requireAuth="cloud"` gate thinks we're in.
// PageShell reads session via /api/session/me; we intercept that call.

const me = {
  user: {
    id: 'u_demo',
    email: 'fede@floom.dev',
    name: 'Federico',
    image: null,
    is_local: false,
  },
  active_workspace: {
    id: 'ws_demo',
    slug: 'federico',
    name: "Federico's workspace",
    role: 'admin',
  },
  workspaces: [
    { id: 'ws_demo', slug: 'federico', name: "Federico's workspace", role: 'admin' },
  ],
  cloud_mode: true,
  auth_providers: { google: false, github: false },
};

async function mockRoutes(page, state) {
  await page.route('**/api/session/me', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(me) }),
  );
  await page.route('**/auth/get-session', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ user: me.user }) }),
  );
  await page.route('**/auth/api-key/list', (route) => {
    if (state === 'empty') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    }
    const keys = [
      {
        id: 'k_1',
        name: 'laptop-cli',
        start: 'floom_ab',
        prefix: 'floom_',
        enabled: true,
        createdAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
        updatedAt: new Date(Date.now() - 1000 * 60 * 90).toISOString(),
        lastRequest: new Date(Date.now() - 1000 * 60 * 12).toISOString(),
        expiresAt: null,
      },
      {
        id: 'k_2',
        name: 'github-actions',
        start: 'floom_qx',
        prefix: 'floom_',
        enabled: true,
        createdAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
        updatedAt: new Date(Date.now() - 1000 * 60 * 60 * 24 * 3).toISOString(),
        lastRequest: null,
        expiresAt: null,
      },
    ];
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(keys) });
  });
  await page.route('**/auth/api-key/create', (route) => {
    const created = {
      id: 'k_new',
      name: 'laptop-cli',
      key: 'floom_EXAMPLE_DEMO_KEY_FOR_SCREENSHOTS_ONLY_xxxxxxxxxxxxxxxxxxxxxx',
      start: 'floom_ab',
      prefix: 'floom_',
      enabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastRequest: null,
      expiresAt: null,
    };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(created) });
  });
  await page.route('**/auth/api-key/delete', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{"success":true}' }),
  );
}

async function shoot(state, outFile) {
  const page = await context.newPage();
  await mockRoutes(page, state);
  await page.goto(`${base}/me/api-keys`);
  // Wait for either the empty state or the keys table to render.
  await page.waitForFunction(
    () =>
      !!document.querySelector('[data-testid="tokens-empty"]') ||
      !!document.querySelector('[data-testid="tokens-list"]'),
    { timeout: 10_000 },
  );
  if (state === 'display-once') {
    await page.click('[data-testid="tokens-create-trigger"]');
    await page.fill('[data-testid="tokens-create-name"]', 'laptop-cli');
    await page.click('[data-testid="tokens-create-submit"]');
    await page.waitForSelector('[data-testid="tokens-display-once"]');
  }
  // Settle layout.
  await page.waitForTimeout(300);
  await page.screenshot({ path: outFile, fullPage: true });
  console.log(`wrote ${outFile}`);
  await page.close();
}

try {
  await shoot('empty', join(OUT_DIR, 'empty.png'));
  await shoot('created', join(OUT_DIR, 'created.png'));
  await shoot('display-once', join(OUT_DIR, 'display-once.png'));
} finally {
  await browser.close();
  server.close();
}
