import type { Page } from '@playwright/test';

/** Minimal valid bodies for fast-apps sidecar slugs when defaults are insufficient. */
export const FAST_APP_FIXTURES: Record<string, Record<string, string>> = {
  'json-format': { text: '{"hello":"world"}' },
  'jwt-decode': {
    token:
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c',
  },
  // Server requires non-empty `text` for these; empty default fails client "required" validation.
  hash: { text: 'hello' },
  base64: { text: 'hello' },
  'word-count': { text: 'hello world' },
};

const FAST_SLUGS = [
  'uuid',
  'password',
  'hash',
  'base64',
  'json-format',
  'jwt-decode',
  'word-count',
] as const;

export function fastAppSlugs(): readonly string[] {
  return FAST_SLUGS;
}

/**
 * Fill known textareas/inputs by manifest field id `floom-inp-<name>`.
 */
export async function applyFastFixtures(page: Page, slug: string): Promise<void> {
  const fx = FAST_APP_FIXTURES[slug];
  if (!fx) return;
  for (const [name, value] of Object.entries(fx)) {
    const id = `floom-inp-${name}`;
    const loc = page.locator(`#${id}`);
    await loc.waitFor({ state: 'visible', timeout: 15_000 });
    await loc.fill(value);
  }
}
