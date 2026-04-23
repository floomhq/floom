// Render all four email templates to .playwright-mcp/audit/email-previews/*.html
// for eyeballing in a browser. Not shipped; this is a dev-only preview tool.
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  renderResetPasswordEmail,
  renderVerificationEmail,
  renderWaitlistConfirmationEmail,
  renderWelcomeEmail,
} from '../apps/server/src/lib/email.ts';

const outDir = resolve(
  '/Users/federicodeponte/Documents/floomhq:floom/.playwright-mcp/audit/email-previews',
);
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
