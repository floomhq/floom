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
    const successIterate = page.locator('.iterate-label');

    try {
      await successIterate.waitFor({ state: 'visible', timeout: 120_000 });
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

    await expect(successIterate).toBeVisible();
  });
}
