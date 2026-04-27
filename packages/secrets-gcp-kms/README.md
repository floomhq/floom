# @floomhq/secrets-gcp-kms

GCP Cloud KMS-backed `SecretsAdapter` for Floom protocol 0.2.

This adapter uses envelope encryption: Floom generates a fresh 256-bit DEK
for each secret, encrypts the plaintext locally with AES-256-GCM, then wraps
only the DEK with GCP KMS. Secret plaintext is never sent to KMS.

```ts
import { createGcpKmsSecretsAdapter } from '@floomhq/secrets-gcp-kms';

const secrets = createGcpKmsSecretsAdapter({
  keyName: 'projects/my-project/locations/global/keyRings/floom/cryptoKeys/secrets',
  storage,
});
```

The provided storage adapter must expose Floom's encrypted secret row methods
from `@floom/adapter-types`.
