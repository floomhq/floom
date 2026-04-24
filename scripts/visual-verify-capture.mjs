#!/usr/bin/env node
// Capture desktop + mobile screenshots of key preview.floom.dev routes.
//
// Env:
//   BASE_URL  - e.g. https://preview.floom.dev (default)
//   OUT_DIR   - directory to write PNGs + capture-manifest.json
//
// Output layout:
//   $OUT_DIR/shots/<viewport>/<slug>.png
//   $OUT_DIR/capture-manifest.json

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const BASE_URL = process.env.BASE_URL || 'https://preview.floom.dev';
const OUT_DIR = process.env.OUT_DIR || path.join(process.cwd(), 'visual-verify-output');
const SHOTS_DIR = path.join(OUT_DIR, 'shots');

// Keep this list in sync with the wireframes at wireframes.floom.dev/v17/*.
const ROUTES = [
  { slug: 'home', path: '/' },
  { slug: 'apps', path: '/apps' },
  { slug: 'p-lead-scorer', path: '/p/lead-scorer' },
  { slug: 'p-resume-screener', path: '/p/resume-screener' },
  { slug: 'p-competitor-analyzer', path: '/p/competitor-analyzer' },
  { slug: 'docs', path: '/docs' },
  { slug: 'login', path: '/login' },
  { slug: 'waitlist', path: '/waitlist' },
  { slug: 'install-lead-scorer', path: '/install/lead-scorer' },
  { slug: '404', path: '/nonexistent-xyz-visual-verify' },
];

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];

async function main() {
  fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const browser = await chromium.launch();
  const manifest = {
    base_url: BASE_URL,
    captured_at: new Date().toISOString(),
    routes: [],
  };

  try {
    for (const vp of VIEWPORTS) {
      const vpDir = path.join(SHOTS_DIR, vp.name);
      fs.mkdirSync(vpDir, { recursive: true });

      const context = await browser.newContext({
        viewport: { width: vp.width, height: vp.height },
        deviceScaleFactor: 1,
      });

      for (const route of ROUTES) {
        const url = `${BASE_URL}${route.path}`;
        const filename = `${route.slug}.png`;
        const filePath = path.join(vpDir, filename);

        console.log(`[capture] ${vp.name} ${url}`);
        const page = await context.newPage();
        const entry = {
          slug: route.slug,
          path: route.path,
          url,
          viewport: vp.name,
          viewport_width: vp.width,
          viewport_height: vp.height,
          file: path.relative(OUT_DIR, filePath),
          status: null,
          error: null,
        };

        try {
          const resp = await page.goto(url, {
            waitUntil: 'networkidle',
            timeout: 30_000,
          });
          entry.status = resp ? resp.status() : null;
          // Small settle delay for hydration / lazy content.
          await page.waitForTimeout(1_500);
          await page.screenshot({ path: filePath, fullPage: false });
        } catch (err) {
          entry.error = String(err && err.message ? err.message : err);
          // Still try to capture whatever is on screen.
          try {
            await page.screenshot({ path: filePath, fullPage: false });
          } catch {}
          console.warn(`[capture] WARN ${url}: ${entry.error}`);
        } finally {
          await page.close();
        }

        manifest.routes.push(entry);
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  const manifestPath = path.join(OUT_DIR, 'capture-manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`[capture] wrote manifest: ${manifestPath}`);
  console.log(`[capture] total shots: ${manifest.routes.length}`);
}

main().catch((err) => {
  console.error('[capture] fatal:', err);
  process.exit(1);
});
