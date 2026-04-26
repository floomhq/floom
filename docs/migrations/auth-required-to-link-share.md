# Migrating `auth_required` To Link Share Auth

ADR-008 replaces the legacy `apps.auth_required` column with the per-app
`apps.link_share_requires_auth` flag.

## What Changes

On server boot, Floom adds:

```sql
apps.link_share_requires_auth INTEGER NOT NULL DEFAULT 0
```

Then it migrates legacy rows:

- `auth_required = 1` becomes `visibility = 'link'`
- `link_share_requires_auth` becomes `1`
- `link_share_token` is generated when missing
- `auth_required = 0` and `auth_required IS NULL` rows keep their visibility
- `visibility='public' AND auth_required=1` rows are moved to `private`, receive
  a review note, and emit a warning because that state was not a valid legacy
  sharing configuration

After the row migration finishes, Floom drops the `apps.auth_required` column.
Re-running the migration is a no-op once the column is gone.

## Operator Notes

No manual SQL is required. Start the upgraded server against the existing
SQLite database and let the boot migration complete.

Self-host manifests that still contain:

```yaml
auth_required: true
```

continue to publish. The field is deprecated and logged as a warning. New
manifests use:

```yaml
link_share_requires_auth: true
```

Do not declare both fields in one manifest; publish rejects that input.
