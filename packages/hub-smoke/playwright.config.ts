import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'https://preview.floom.dev';
const hasE2EAuth = Boolean(process.env.E2E_EMAIL && process.env.E2E_PASSWORD);

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  timeout: 180_000,
  ...(hasE2EAuth ? { globalSetup: './global-setup.ts' } : {}),
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
    ...devices['Desktop Chrome'],
    ...(hasE2EAuth ? { storageState: '.auth/user.json' } : {}),
  },
});
