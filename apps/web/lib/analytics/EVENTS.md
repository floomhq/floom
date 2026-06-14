# Workeros PostHog Events

All events are emitted through `apps/web/lib/analytics/capture.ts` and no-op when
`NEXT_PUBLIC_POSTHOG_KEY` is not set. Every event includes the `product`
super-property from `NEXT_PUBLIC_POSTHOG_PRODUCT` or `workeros-oss`.

## Identity And Groups

- `posthog.identify(user_id, { workspace_id, role, created_at })`
  - Source: `apps/web/lib/analytics/posthog-provider.tsx`
  - `created_at` is sent when the active `/api/me` implementation exposes it.
- `posthog.group("workspace", workspace_id, { name, member_count, created_at })`
  - Source: `apps/web/lib/analytics/posthog-provider.tsx`
  - Group enrichment reads `/workspaces` and `/workspace/members` through the configured API proxy base.

## Event Catalog

| Event | Main source | Properties |
| --- | --- | --- |
| `signed_up` | `app/login/page.tsx` OSS setup flow | `source` |
| `logged_in` | `app/login/page.tsx`, `app/auth/magic/[token]/page.tsx` | `source` |
| `logged_out` | `components/layout/sidebar.tsx` | `source` |
| `onboarding_step_completed` | `app/login/page.tsx` OSS setup flow | `step` |
| `onboarding_completed` | `app/login/page.tsx` OSS setup flow | `source` |
| `worker_created` | `lib/api.ts` worker create/import/prompt APIs | `worker_id`, `source`, `trigger_type`, `tools`, optional `run_id`, `import_type`, `$set_once.first_worker_created_at` |
| `worker_edited` | `lib/api.ts` worker update/updateFiles APIs | `worker_id`, `edit_surface`, `file_count`, `trigger_type`, `tools` |
| `worker_deleted` | `lib/api.ts` worker delete API | `worker_id` |
| `worker_archived` | `lib/api.ts` worker archive API | `worker_id`, `trigger_type`, `tools` |
| `worker_shared` | `lib/api.ts` worker visibility/share-link APIs | `worker_id`, `share_type` |
| `worker_run_started` | `lib/api.ts` worker run/replay APIs | `worker_id`, `run_id`, `trigger` |
| `worker_run_completed` | `lib/api.ts` run list/detail APIs | `run_id`, `worker_id`, `status`, `duration_ms`, `tokens`, `cost_usd` |
| `worker_run_failed` | `lib/api.ts` run list/detail APIs | `run_id`, `worker_id`, `status`, `duration_ms`, `tokens`, `cost_usd`, `error_type` |
| `connection_added` | `lib/api.ts`, `lib/oauth-popup.ts`, `app/connections/redirect/page.tsx` | `connection_id`, `app`, `connection_type`, optional `tool_count` |
| `connection_removed` | `lib/api.ts` connection delete API | `connection_id` |
| `connection_reauth` | `lib/api.ts` connection list API | `connection_id`, `app` |
| `brain_folder_created` | `lib/api.ts` context create API | `writeable` |
| `brain_file_added` | `lib/api.ts` context upload/save APIs | `file_count`, `file_type`, `tag_count`, `size_bytes`, `created_folder`, `$set_once.first_brain_file_added_at` |
| `brain_shared` | `lib/api.ts` context visibility/share-link APIs | `share_type`, optional `file_type` |
| `emily_chat_started` | `lib/useChatStream.ts` | `source`, `$set_once.first_emily_chat_started_at` |
| `emily_message_sent` | `lib/useChatStream.ts` | `conversation_id`, `has_attachments`, `attachment_count`, `length_bucket` |
| `emily_tool_used` | `lib/useChatStream.ts` | `tool` |
| `emily_worker_created_from_prompt` | `lib/api.ts`, `lib/useChatStream.ts` | `worker_id`, optional `run_id`, `tool`, `$set_once.first_worker_created_at` |
| `approval_requested` | `lib/api.ts` approval list API | `approval_id`, `run_id`, `worker_id`, `approval_type` |
| `approval_approved` | `lib/api.ts` approval/run approve APIs | `approval_id` or `run_id`, `approval_type`, `has_annotations` |
| `approval_rejected` | `lib/api.ts` approval/run reject APIs | `approval_id` or `run_id`, `approval_type`, `has_reason`, `has_annotations` |
| `channel_install_started` | `lib/api.ts` connection/slack install APIs | `channel` |
| `channel_installed` | `lib/api.ts`, `lib/oauth-popup.ts`, `app/connections/redirect/page.tsx` | `channel` |
| `channel_install_failed` | `lib/api.ts`, `lib/oauth-popup.ts`, `app/connections/redirect/page.tsx` | `channel`, `error_type` |
| `setting_changed` | `lib/api.ts` workspace settings API | `key`, `value_type` |
| `$exception` | PostHog autocapture and `app/error.tsx` | PostHog exception fields plus sanitized `product`, `source`, `digest`, `error_type` where captured by the error boundary |
| `api_error` | `lib/api.ts` fetch wrappers and manual upload/import fetches | `route`, `status`, `error_type` |
| `collection_filter_changed` | `components/collection/CollectionView.tsx` | `collection`, `filter`, optional `selected_count` |
| `view_toggled` | `components/collection/CollectionView.tsx` | `collection`, `view` |

## Privacy Rules

- Do not send emails, usernames, display names, message text, prompt text, file
  names, folder names, secret names, passwords, token values, OAuth URLs, API
  keys, approval comments, or run inputs/outputs.
- Message analytics use `length_bucket`, not content.
- API error routes are templated and strip query strings and dynamic ids.
- PostHog masking remains enabled: `mask_all_text`, `mask_all_element_attributes`,
  and masked session-recording inputs.
- Workspace names are sent only as PostHog group properties because group
  analytics explicitly requires `{ name, member_count, created_at }`.

## Cloud Supabase Auth Hook

The shared `apps/web` engine in this branch does not contain the Cloud
Supabase sign-up/sign-in UI; it only contains the OSS login/setup/magic-link
flows. The Cloud overlay that calls `supabase.auth.signUp`, `signInWithOtp`,
`signInWithPassword`, OAuth callback handling, or equivalent session exchange
must call:

- `capture("signed_up", { source: "supabase" })` after a new Supabase user is created.
- `capture("logged_in", { source: "supabase" })` after a Supabase session is established.
- `capture("onboarding_step_completed", { step: "<stable_step>" })` and
  `capture("onboarding_completed", { source: "supabase" })` at the Cloud
  onboarding completion boundary.

The existing `PostHogProvider` will identify and group the user after the Cloud
overlay exposes the authenticated session through `/api/me`.
