import { test, expect } from '@playwright/test';
import { applyFastFixtures, FAST_APP_FIXTURES } from './fixtures';

const hasAuth = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);

/**
 * Full hub sweep: requires storage state from global-setup (E2E_EMAIL + E2E_PASSWORD).
 * Authenticated users get a higher per-hour run cap than anonymous IPs.
 *
 * Outcomes are soft: `passed` = UI reached output (Iterate) or acceptable infra error;
 * `failed` = page error or unexpected throw.
 */
test.describe('@full hub directory (auth)', () => {
  test.skip(!hasAuth, 'Set E2E_EMAIL and E2E_PASSWORD to run the full hub sweep.');

  test('every public hub app: load + run attempt', async ({ page, request, baseURL }) => {
    const hub = await request.get(`${baseURL}/api/hub`);
    expect(hub.ok()).toBeTruthy();
    const apps = (await hub.json()) as { slug: string; name?: string }[];
    expect(apps.length).toBeGreaterThan(0);

    const report: { slug: string; outcome: string; detail?: string }[] = [];

    for (const { slug } of apps) {
      await page.goto(`/p/${slug}`, { waitUntil: 'domcontentloaded' });
      const floom = page.getByTestId('run-surface');
      if ((await floom.count()) === 0) {
        report.push({ slug, outcome: 'skip', detail: 'no run-surface (not found or blocked)' });
        continue;
      }

      if (slug in FAST_APP_FIXTURES) {
        await applyFastFixtures(page, slug);
      }

      await page.getByTestId('run-surface-run-btn').click();

      const errorBanner = page.getByText('Something went wrong');
      const successIterate = page.locator('.iterate-label');

      await Promise.race([
        successIterate.waitFor({ state: 'visible', timeout: 150_000 }),
        errorBanner.waitFor({ state: 'visible', timeout: 150_000 }),
      ]).catch(() => {
        /* timeout — record below */
      });

      if (await successIterate.isVisible().catch(() => false)) {
        report.push({ slug, outcome: 'passed' });
        continue;
      }

      if (await errorBanner.isVisible().catch(() => false)) {
        const detail = await page.locator('.app-expanded-card').filter({ hasText: /Something went wrong/ }).innerText();
        const soft =
          /GEMINI|docker|secret|timeout|429|rate|upstream|ECONNREFUSED|API key/i.test(detail);
        report.push({
          slug,
          outcome: soft ? 'infra_or_config' : 'failed',
          detail: detail.slice(0, 400),
        });
        continue;
      }

      report.push({ slug, outcome: 'timeout_or_unknown' });
    }

    console.log(JSON.stringify({ total: apps.length, results: report }, null, 2));

    const hardFails = report.filter((r) => r.outcome === 'failed' || r.outcome === 'timeout_or_unknown');
    expect(
      hardFails,
      `Hard failures: ${JSON.stringify(hardFails)}`,
    ).toHaveLength(0);
  });
});
