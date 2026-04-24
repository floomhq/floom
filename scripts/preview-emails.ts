// Render all four email templates to an output directory for eyeballing
// in a browser. Not shipped; this is a dev-only preview tool.
//
// Run: `pnpm tsx scripts/preview-emails.ts` (or `node --import tsx ...`).
// Override the output directory with PREVIEW_OUT_DIR, e.g.
// `PREVIEW_OUT_DIR=/tmp/email-previews pnpm tsx scripts/preview-emails.ts`.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  renderResetPasswordEmail,
  renderVerificationEmail,
  renderWaitlistConfirmationEmail,
  renderWelcomeEmail,
} from '../apps/server/src/lib/email.ts';

const outDir = resolve(process.env.PREVIEW_OUT_DIR || '.email-previews');
mkdirSync(outDir, { recursive: true });

const publicUrl = 'https://floom.dev';
const demoToken = 'demo-token-abc123def456';

const emails = {
  'waitlist.html': renderWaitlistConfirmationEmail({ publicUrl }),
  'welcome.html': renderWelcomeEmail({ publicUrl, name: 'Federico' }),
  'verify.html': renderVerificationEmail({
    name: 'Federico',
    verifyUrl: `${publicUrl}/auth/verify-email/${demoToken}?callbackURL=/studio`,
  }),
  'reset.html': renderResetPasswordEmail({
    name: 'Federico',
    resetUrl: `${publicUrl}/auth/reset-password/${demoToken}?callbackURL=/reset-password`,
  }),
};

for (const [name, { subject, html }] of Object.entries(emails)) {
  writeFileSync(resolve(outDir, name), html);
  console.log(`${name} — subject: ${subject}`);
}

console.log(`\nRendered to: ${outDir}`);
