import { test, expect } from '@playwright/test';
import { applyFastFixtures, fastAppSlugs } from './fixtures';

/**
 * Deterministic proxied apps (fast-apps sidecar). Safe for anonymous preview:
 * stays under per-IP run rate limits when run serially (7 ≪ 20/hr).
 */
for (const slug of fastAppSlugs()) {
  test(`@fast ${slug}: permalink loads and run succeeds`, async ({ page }) => {
    await page.goto(`/p/${slug}`, { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('run-surface')).toBeVisible({ timeout: 30_000 });

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
