import { customAlphabet } from 'nanoid';

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
