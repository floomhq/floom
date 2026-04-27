# @floomhq/storage-postgres

Postgres implementation of the Floom protocol `StorageAdapter`.

```ts
import { createPostgresAdapter } from '@floomhq/storage-postgres';

const storage = createPostgresAdapter({
  connectionString: process.env.DATABASE_URL!,
});
```

The package also exports `schema.sql` for explicit database setup.
