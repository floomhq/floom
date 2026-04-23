import { test, expect } from '@playwright/test';
import { applyFastFixtures, fastAppSlugs } from './fixtures';

/**
 * Deterministic proxied apps (fast-apps sidecar). Safe for anonymous preview:
 * stays under per-IP run rate limits when run serially (7 ≪ 20/hr).
 */
for (const slug of fastAppSlugs()) {
  test(`@fast ${slug}: permalink loads and run succeeds`, async ({ page }) => {
    // `data-testid="run-surface"` mounts only after GET /api/hub/:slug succeeds
    // (AppPermalinkPage keeps a skeleton until then). Waiting on
    // `domcontentloaded` alone races hydration + API latency on cold preview.
    const hubPath = `/api/hub/${slug}`;
    const hubJson = page.waitForResponse(
      (res) => {
        if (res.request().method() !== 'GET' || res.status() !== 200) return false;
        try {
          const path = new URL(res.url()).pathname;
          return path === hubPath || path === `${hubPath}/`;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    );

    await page.goto(`/p/${slug}`, { waitUntil: 'load', timeout: 60_000 });
    await hubJson;

    await page.getByTestId('run-surface').waitFor({ state: 'visible', timeout: 30_000 });

    const notFound = page.getByRole('heading', { name: /not found/i });
    if ((await notFound.count()) > 0) {
      await expect(notFound).toHaveCount(0);
    }

    await applyFastFixtures(page, slug);

    await page.getByTestId('run-surface-run-btn').click();

    const errorBanner = page.getByText('Something went wrong');
    // 2026-04-20 (P2 fix 5): previously waited on `.iterate-label`, which
    // only renders for `refinable: true` apps. None of the fast-apps are
    // refinable, so the selector never appeared and every PR's `fast-apps`
    // job timed out at 120s. Wait for `[data-renderer]` instead — every
    // output renderer in packages/renderer attaches it after mount, so
    // this is a proven post-render signal that's resilient to manifest
    // changes (refinable flips, iterate UI reshuffles).
    const successOutput = page.locator('[data-renderer]').first();

    try {
      await successOutput.waitFor({ state: 'visible', timeout: 120_000 });
    } catch {
      if (await errorBanner.isVisible().catch(() => false)) {
        const msg = await page
          .locator('.app-expanded-card')
          .filter({ hasText: /Something went wrong/ })
          .textContent();
        throw new Error(`Run failed for ${slug}: ${msg ?? 'unknown'}`);
      }
      throw new Error(`Timeout waiting for run output (slug=${slug})`);
    }

    await expect(successOutput).toBeVisible();
  });
}
