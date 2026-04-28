#!/usr/bin/env node
// Launch-blocker audit: transactional email templates and Resend fallback.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'floom-email-transactional-'));
process.env.DATA_DIR = tmp;
process.env.FLOOM_DISABLE_JOB_WORKER = 'true';
delete process.env.RESEND_API_KEY;

const email = await import('../../apps/server/dist/lib/email.js');

let passed = 0;
let failed = 0;
function log(label, ok, detail) {
  if (ok) {
    passed++;
    console.log(`  ok  ${label}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ' :: ' + detail : ''}`);
  }
}

console.log('Transactional email smoke');

const verification = email.renderVerificationEmail({
  name: 'Federico',
  verifyUrl: 'https://floom.dev/auth/verify?token=test',
});
log('verification email has subject', verification.subject === 'Verify your Floom email');
log('verification email contains verify URL in text', verification.text.includes('https://floom.dev/auth/verify?token=test'));
log('verification email contains verify CTA in HTML', verification.html.includes('Verify email'));

const reset = email.renderResetPasswordEmail({
  name: 'Federico',
  resetUrl: 'https://floom.dev/auth/reset-password/test',
});
log('password reset email has subject', reset.subject === 'Reset your Floom password');
log('password reset email contains reset URL in text', reset.text.includes('https://floom.dev/auth/reset-password/test'));
log('password reset email states expiry', reset.text.includes('1 hour'));

const invite = email.renderAppInviteEmail({
  appName: 'Competitor Lens',
  inviterName: 'Floom Ops',
  acceptUrl: 'https://floom.dev/apps/invite/test',
});
log('app invite email has subject', invite.subject === "You're invited to Competitor Lens on Floom");
log('app invite email contains accept URL', invite.text.includes('https://floom.dev/apps/invite/test'));
log('app invite email escapes app name into HTML', invite.html.includes('Competitor Lens'));

email._resetEmailForTests();
const delivered = await email.sendEmail({
  to: 'launch-smoke@example.com',
  subject: 'Launch smoke',
  html: '<p>ok</p>',
  text: 'ok',
});
log('sendEmail succeeds with stdout fallback when RESEND_API_KEY is absent', delivered.ok === true);
log('stdout fallback reason is explicit', delivered.reason === 'stdout_fallback', JSON.stringify(delivered));

rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
