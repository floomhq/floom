# App Sharing And Review

Floom apps are owner-only by default. The backend stores the sharing mode in
`apps.visibility` and enforces it on the read and run paths.

## Visibility States

| State | Visitor access | Directory listing |
| --- | --- | --- |
| `private` | Owner only | Hidden |
| `link` | Anyone with `/p/:slug?key=<token>` | Hidden |
| `invited` | Owner and accepted invitees | Hidden |
| `pending_review` | Owner only | Hidden |
| `public_live` | Anyone | Listed in `/apps` |
| `changes_requested` | Owner only | Hidden |

Legacy self-host rows with `visibility='public'` continue to behave as public
when `publish_status='published'`. New app publishes default to `private`.

`link_share_requires_auth` is an optional per-app flag for `link` visibility.
When it is `0`, anyone with `/p/:slug?key=<token>` can open and run the app.
When it is `1`, the caller also needs a signed-in Floom session.

The old manifest field `auth_required` is deprecated. Publishing a manifest
with `auth_required: true` still works for backward compatibility: the backend
maps it to `visibility='link'`, `link_share_requires_auth=1`, and creates a
`link_share_token` when one is missing. New manifests use
`link_share_requires_auth: true`. A manifest that declares both fields is
rejected.

## State Machine

Owner transitions:

```text
private -> link
private -> invited
private -> pending_review
link -> private
invited -> private
changes_requested -> pending_review
public_live -> private
pending_review -> private  (withdraw review)
```

Reviewer transitions:

```text
pending_review -> public_live
pending_review -> changes_requested
```

Admin emergency transition:

```text
any state -> private
```

Every transition writes `app_visibility_audit` with the actor, timestamp,
reason, before/after states, and optional metadata.

## Invites

Owners invite by username or email:

- Existing users receive a `pending_accept` invite.
- Unknown email addresses receive a `pending_email` invite and an email with a
  sign-up link.
- On first verified sign-in, matching `pending_email` invites are linked to the
  new user and moved to `pending_accept`.
- Accepting moves the invite to `accepted`.
- Owners can revoke invites at any time.
- Invitees can decline or leave, which moves the invite to `declined`.

Only `accepted` invites grant access when the app is in `invited` visibility.

## Review Process

Owners submit a private app for Store review with
`POST /api/me/apps/:slug/sharing/submit-review`. While review is pending, the
app is visible only to its owner. Reviewers approve to `public_live` or reject
to `changes_requested` with a comment. Owners fix the app and resubmit from
`changes_requested` back to `pending_review`.

Admin APIs:

- `GET /api/admin/review-queue`
- `GET /api/admin/review-queue/:slug`
- `POST /api/admin/review-queue/:slug/approve`
- `POST /api/admin/review-queue/:slug/reject`
- `POST /api/admin/apps/:slug/takedown`
- `GET /api/admin/audit-log?app_id=...`

Admins are users with `users.is_admin=1`. At boot and on sign-in, emails listed
in `FLOOM_ADMIN_EMAILS` are flagged as admins.
