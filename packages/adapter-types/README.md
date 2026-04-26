# @floom/adapter-types

TypeScript contracts for Floom adapters.

This package exports the five protocol adapter interfaces:

- `RuntimeAdapter`
- `StorageAdapter`
- `AuthAdapter`
- `SecretsAdapter`
- `ObservabilityAdapter`

It also exports the supporting manifest, app, run, job, workspace, user, session, and filter types those interfaces reference.

Protocol details, method semantics, and invariants live in [`spec/adapters.md`](../../spec/adapters.md).

## Version Policy

The package version matches the server `FLOOM_PROTOCOL_VERSION`. Version `0.2.0` corresponds to adapter protocol `0.2.0`.

Pre-1.0 minor versions can change the adapter contract. Third-party adapters are expected to declare a narrow compatibility range, for example:

```json
{
  "peerDependencies": {
    "@floom/adapter-types": "^0.2"
  }
}
```

## Usage

```ts
import type { StorageAdapter } from '@floom/adapter-types';

export const postgresStorageAdapter: StorageAdapter = {
  // implement every StorageAdapter method
};
```
