# Cloud Storage Seam Audit

Issue: #208

Engine submodule audited at `63e5b58335fe265f40a18d0b74e54f7417ec602f`.

## Verdicts

| Cloud module | Engine equivalent | Verdict |
| --- | --- | --- |
| `apps/api/cloud_scheduler.py` | `engine/apps/api/scheduler.py` | Storage-only / thin cloud wiring |
| `apps/api/cloud_webhooks.py` | `engine/apps/api/webhook_service.py` | Drift fixed |
| `apps/api/cloud_whatsapp.py` | `engine/apps/api/channels/whatsapp.py` | Drift documented |
| `apps/api/cloud_git.py` | `engine/apps/api/git_ops.py` | Storage-only config seam |

## `apps/api/cloud_scheduler.py`

Verdict: storage-only / thin cloud wiring.

The cloud module does not reimplement scheduling semantics. It reads cloud DB
connection env vars, acquires a Postgres advisory lock, delegates scheduler
start/stop to the engine, and releases the lock:

- Cloud lock/env wiring: `apps/api/cloud_scheduler.py:16`
- Delegates start to engine scheduler: `apps/api/cloud_scheduler.py:60`
- Delegates stop to engine scheduler: `apps/api/cloud_scheduler.py:79`

The business logic for due schedules, cron computation, run creation,
concurrency, missing inputs, missing secrets/connections, owner lifecycle, and
next-run advancement remains in `engine/apps/api/scheduler.py`.

Recommended follow-up: none for #208.

## `apps/api/cloud_webhooks.py`

Verdict: drift fixed.

Before this audit, the cloud module generated and verified webhook secrets with
cloud-owned hashing/token code. That duplicated engine webhook business logic.
The cloud module now delegates token generation, token verification, secret
lookup, and secret deletion to `engine/apps/api/webhook_service.py`; it retains
only the cloud URL seam for `WORKEROS_API_BASE` / `/api/webhooks`.

Current cloud-owned surface:

- Cloud URL base and `/api` prefix: `apps/api/cloud_webhooks.py:27`
- Engine token delegation for surfaced URL: `apps/api/cloud_webhooks.py:52`
- Engine generation/verification/deletion wrappers: `apps/api/cloud_webhooks.py:59`

Repository contract fix:

- `SupabaseWorkerRepository.get_webhook_secret_hash()` now returns `str | None`
  to match `engine/apps/api/db/interface.py` and `engine/apps/api/webhook_service.py`.
- The Supabase column can remain bytea; the repository converts stored bytea to
  the hex string consumed by the engine token logic.

Recommended follow-up: none for #208.

## `apps/api/cloud_whatsapp.py`

Verdict: drift documented.

This module is partly a Supabase storage seam, but it also reimplements pieces
of WhatsApp binding workflow logic that already exist in
`engine/apps/api/channels/whatsapp.py`.

Storage-only portions:

- Supabase CRUD helpers for `whatsapp_sender_bindings`: `apps/api/cloud_whatsapp.py:51`
- `last_seen_at` update persistence: `apps/api/cloud_whatsapp.py:79`
- Supabase pending reset persistence: `apps/api/cloud_whatsapp.py:90`

Business-logic drift:

- WA ID normalization is duplicated with a local regex at
  `apps/api/cloud_whatsapp.py:117`; engine normalization lives at
  `engine/apps/api/channels/whatsapp.py:118`.
- Active-binding semantics are duplicated in `_cloud_binding_info()`:
  status check, `user_id` requirement, last-seen side effect, and
  `local-default` fallback at `apps/api/cloud_whatsapp.py:110`. The engine
  equivalent is `engine/apps/api/channels/whatsapp.py:158`.
- Claim creation partially delegates to the engine, but then reimplements the
  active-binding guard and pending-row upsert into Supabase at
  `apps/api/cloud_whatsapp.py:147`. The engine claim rules live at
  `engine/apps/api/channels/whatsapp.py:196`.
- Reset-to-pending delegates to the engine, then parses the claim URL and
  recomputes the 24-hour expiry at `apps/api/cloud_whatsapp.py:183`. The
  engine reset logic lives at `engine/apps/api/channels/whatsapp.py:260`.

Recommended fix:

Move WhatsApp binding persistence behind an engine-level repository/interface
owned by `channels.whatsapp`. Then cloud can provide a Supabase implementation
for operations such as `get_binding`, `upsert_pending_claim`,
`activate_claim`, `update_last_seen`, and `reset_to_pending`, while the engine
keeps normalization, active/pending rules, token expiry, claim URL construction,
and fallback decisions. This is not a safe small refactor in this branch because
the current cloud code monkey-patches private engine functions and dual-writes
to SQLite/Supabase.

## `apps/api/cloud_git.py`

Verdict: storage-only config seam.

The audited file no longer implements git business operations. It only reads
the `git_workspace_config` Supabase row for a workspace:

- Supabase config lookup: `apps/api/cloud_git.py:16`

The engine git operation logic remains in `engine/apps/api/git_ops.py`.

Note: `apps/api/cloud_git_local.py` is outside the specific #208 module list.
It contains cloud-owned per-workspace git checkout and Supabase bundle storage
logic, and it is the place to audit separately if the scope expands from
`cloud_git.py` to the full cloud git override system.
