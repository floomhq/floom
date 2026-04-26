# Review Queue SOP

The review queue contains apps in `pending_review`. Reviewers use the backend
admin API; the UI can layer on top later.

## Access

Reviewers need `users.is_admin=1`. Seed operational admins with:

```bash
FLOOM_ADMIN_EMAILS=admin@example.com,reviewer@example.com
```

Do not commit real admin emails into code or docs beyond examples.

## Review Steps

1. Open `GET /api/admin/review-queue`.
2. Inspect one app with `GET /api/admin/review-queue/:slug`.
3. Run the app through the normal `/p/:slug` and `/api/:slug/run` paths using
   owner/test credentials when needed.
4. Approve with `POST /api/admin/review-queue/:slug/approve` when the app is
   safe, functional, and accurately described.
5. Reject with `POST /api/admin/review-queue/:slug/reject` and a clear
   `{ "comment": "..." }` when changes are needed.

Approval moves the app to `public_live` and lists it in `/apps`. Rejection moves
the app to `changes_requested`; the owner sees the latest comment and can
resubmit.

## Emergency Takedown

Use `POST /api/admin/apps/:slug/takedown` with an optional reason for abuse,
security issues, broken upstreams, or legal requests. This moves the app to
`private` from any state and writes an audit-log row.

## Audit

Use `GET /api/admin/audit-log?app_id=<app_id>` to inspect transition history.
Rows include actor, reason, previous state, next state, metadata, and timestamp.
