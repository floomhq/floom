# Email Verification

Date: 2026-04-27

Verdict: **PASS for implemented Resend-backed transactional templates.**

Raw capture: `/tmp/floom-track-c/email-results.json`

Recipient used for every send:

```text
depontefede+floom-test@gmail.com
```

Credential source: live `floom-preview-launch` container environment.

Sender:

```text
Floom <noreply@send.floom.dev>
```

## Sent Emails

| Kind | Subject | Resend message id |
| --- | --- | --- |
| `SIGNUP_CONFIRMATION` | `Verify your Floom email` | `69bc2cce-09e9-4e49-ba6c-36ed656b3362` |
| `PASSWORD_RESET` | `Reset your Floom password` | `627dbfed-a51e-4533-9b75-eefbb9080df7` |
| `APP_INVITE` | `You're invited to Track C Verification App on Floom` | `8437c5bf-8904-41d5-a316-44437bb140e1` |

All three sends returned `{ ok: true }` from the real `sendEmail()` helper in `apps/server/src/lib/email.ts`.

## Workspace Invite Status

Verdict: **not implemented as an email send path yet**.

`POST /api/workspaces/:id/members/invite` currently returns an invite object plus `accept_url`. There is no `renderWorkspaceInviteEmail` helper and no `sendEmail()` call in the workspace invite route or service.

The implemented invite email path today is app invite delivery through `renderAppInviteEmail()` in `apps/server/src/lib/email.ts` and `sendEmail()` in `apps/server/src/routes/me_apps.ts`.

## Self-Audit

- No address other than `depontefede+floom-test@gmail.com` was used.
- The Resend API key was read only from the live preview container environment.
- Real Resend provider IDs were captured for every implemented send.
- No stdout fallback occurred.
