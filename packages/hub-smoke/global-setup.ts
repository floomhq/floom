import { chromium } from '@playwright/test';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const authFile = join(__dirname, '.auth', 'user.json');

/**
 * Saves storage state after email/password sign-in (Better Auth + cloud mode).
 * Requires BASE_URL, E2E_EMAIL, E2E_PASSWORD.
 */
export default async function globalSetup() {
  const base = process.env.BASE_URL || 'https://preview.floom.dev';
  const email = process.env.E2E_EMAIL;
  const password = process.env.E2E_PASSWORD;
  if (!email || !password) return;

  mkdirSync(dirname(authFile), { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`${base}/login`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('input-email').fill(email);
  await page.getByTestId('input-password').fill(password);
  await page.getByTestId('submit-password').click();

  await page.waitForURL(
    (u) => u.pathname.startsWith('/me') || u.pathname === '/' || u.pathname === '/apps',
    { timeout: 60_000 },
  );

  await page.context().storageState({ path: authFile });
  await browser.close();

  if (!existsSync(authFile)) {
    throw new Error(`globalSetup: failed to write ${authFile}`);
  }
}
