import { randomBytes } from 'node:crypto';

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function generateLinkShareToken(): string {
  let token = '';
  while (token.length < 24) {
    const bytes = randomBytes(24);
    for (const byte of bytes) {
      if (byte >= 248) continue;
      token += BASE62[byte % BASE62.length];
      if (token.length === 24) break;
    }
  }
  return token;
}
