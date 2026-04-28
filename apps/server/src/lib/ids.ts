import { customAlphabet } from 'nanoid';
import { randomUUID } from 'node:crypto';

const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
const makeId = (prefix: string) => {
  const gen = customAlphabet(alphabet, 12);
  return () => `${prefix}_${gen()}`;
};

export const newAppId = makeId('app');
export const newRunId = makeId('run');
export const newSecretId = makeId('sec');
export const newThreadId = makeId('thr');
export const newTurnId = makeId('trn');
export const newJobId = makeId('job');
export const newBuildId = makeId('bld');
export const newConnectionId = makeId('con');
export const newAppInviteId = makeId('ainv');
export const newAppInstallId = makeId('ains');
export const newVisibilityAuditId = makeId('vaud');
export const newAuditLogId = () => `audit_${randomUUID()}`;
// W3.3: Stripe Connect partner app
export const newStripeAccountRowId = makeId('sa');
export const newStripeWebhookEventRowId = makeId('swe');
// Triggers (unified schedule + webhook)
export const newTriggerId = makeId('tgr');
