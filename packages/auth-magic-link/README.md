# @floomhq/auth-magic-link

Resend-backed magic-link `AuthAdapter` for Floom protocol 0.2.

```ts
import { createMagicLinkAuthAdapter } from '@floomhq/auth-magic-link';

const auth = createMagicLinkAuthAdapter({
  resendApiKey: process.env.RESEND_API_KEY!,
  fromEmail: 'Floom <login@floom.dev>',
  jwtSecret: process.env.FLOOM_AUTH_JWT_SECRET!,
  storage,
});
```

The default export is a factory-style adapter registration object:

```ts
export default {
  kind: 'auth',
  name: 'magic-link',
  protocolVersion: '^0.2',
  create: createMagicLinkAuthAdapter,
};
```
