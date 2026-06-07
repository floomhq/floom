# Connections detail + tool-picker fixes — brief (2026-06-05, from viewed screenshots)

Now that the 4 screenshots were viewed, precise findings (engine = source of truth; connections UI is engine apps/web; respect engine/cloud boundary). Investigate root cause. Do NOT prod-deploy without ops/smoke-routes.sh.

## M82 (P1 bug) — connection Actions menu does nothing
The connection row "..." Actions menu has THREE items that are non-functional on click: **"Test connection", "Refresh status", "Disconnect"**. Wire all three: Test connection (calls the backend to verify the connection + shows result), Refresh status (re-fetches/updates the connection status), Disconnect (revokes/removes the connection, with confirm). Find the connections table component (apps/web connections page) + the backend endpoints; if endpoints are missing, add them. Verify each action works live.

## M81 (bug) — connection account label shows an ID, not the email; stuck "Connecting"
The Gmail connection row shows account label **"account ...ea71f1"** (a truncated internal id) instead of the actual email (e.g. depontefede@gmail.com), with Scopes "—", Last used "—", and Status stuck on **"Connecting"**. FIX: (a) show the real account identity (email/handle) from the Composio connection metadata, not the internal id; (b) investigate why the status is stuck "Connecting" — a connection that completed OAuth should be "Active". This may relate to the OAuth callback (M57/M58) not finalizing the connection record. Root-cause + fix so a connected Gmail shows the email + Active.

## M84 (UX) — "Add tool" app picker is a plain text dropdown, no logos
The worker editor "Tools this worker can use" -> "Add tool" opens a plain TEXT dropdown (Granola, Gmail, Google Calendar, Google Drive, Slack, Notion, Linear, GitHub, HubSpot, Salesforce, LinkedIn, Apollo, "Other (enter slug)..."). NO brand logos, basic UX. FIX: add the real brand logo (reuse BrandLogo/IconSprite + connection-data, the same system PR #446 used) next to each app in the picker, make it a clean searchable picker. Keep "Other (enter slug)..." for unknowns. Restrained design.

## Discipline
Worktree off origin/main, commit+push each step, PR (admin merge if GH Actions billing-blocks after local tests). Reconcile with the in-flight mcp-account lane (it may also touch connections/account) — do not duplicate; coordinate on file ownership. Run ops/smoke-routes.sh before prod deploy. No secret values, no em dashes in UI. Write docs/CONNECTIONS_DETAIL_FIXES_2026-06-05.md per-item.
