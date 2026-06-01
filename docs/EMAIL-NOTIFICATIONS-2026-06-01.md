# Email Notifications

Workeros Cloud now has a server-side email sender foundation in `apps/api/email.py`.

## Current State

- Provider: Resend.
- OSS engine run notifications already use Resend for worker-level `email_to` notifications. This Cloud module covers product transactional emails such as welcome, workspace, approval, and account lifecycle messages.
- Runtime switch: `WORKEROS_EMAIL_ENABLED=1`.
- Required server-only env:
  - `RESEND_API_KEY`
  - `WORKEROS_EMAIL_FROM`
- Optional safe test mode: `WORKEROS_EMAIL_DRY_RUN=1`.
- No API key is exposed to the frontend.
- With email disabled, missing env, or dry-run mode, sends return a structured `skipped`/`dry_run` result and do not call Resend.
- Welcome email is wired from both password login and Supabase OAuth/magic-link callback.
- Welcome sends are deduped by `public.email_events.dedupe_key` (`welcome:<user_id>`) so repeat logins do not resend.
- Email event rows track recipient, provider, provider message id, status, reason, and timestamps under RLS.

## Not Yet Wired

- Workspace invite/share/transfer emails.
- Approval notification emails.
- Worker run failure/completion notification emails.
- Unsubscribe/preferences UI for non-transactional product email.
