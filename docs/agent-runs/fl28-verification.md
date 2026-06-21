# FL28: Full Worker Setup and Emily Verification (UI, MCP, WhatsApp, Slack)

## PR Status: BLOCKED & NON-CLOSING

> **CRITICAL NOTE:** This PR is explicitly **non-closing** for issue #524. The actual code fix for issue #524 cannot be inferred from the available context, and this PR is currently in a **BLOCKED** state pending further requirements and concrete code changes. No code changes have been implemented in this PR.
>
> **Note on PR Title/Description:** The PR title ("Fix issue #524") and description are automated/system-generated and cannot be modified by the autonomous fixer loop. This PR is intended solely as a documentation-only record of the blocked state and verification planning.

## Blocked State Documentation

- **Reason for Blocked State:** The specific functional requirements, bug reports, or code changes required to resolve issue #524 are not present in the available context.
- **Action Required:** Maintainers or authors must provide the actual code changes or detailed specifications of the defect in issue #524.
- **Verification Status:** All channels are currently **unverified** and marked as **Pending Verification** because no code changes have been introduced. No verification claims are being made.

## Verification Requirements (Post-Fix)

Once the code changes are provided, the following concrete evidence must be produced to verify the fix across all channels:

### 1. UI Channel
- **Required Evidence:**
  - CI execution logs for DOM tests in `apps/web/tests/new-worker-emily-902.dom.test.tsx` and `apps/web/tests/new-worker-emily-chat-only.dom.test.tsx`.
  - Test run outputs for chat streaming and scroll lock verified by `apps/web/tests/fl-scroll-lock.test.ts`.

### 2. WhatsApp Channel
- **Required Evidence:**
  - Webhook signature verification and message parsing test outputs.
  - Live sandbox run logs or webhook delivery receipts.

### 3. MCP Channel
- **Required Evidence:**
  - Test execution logs of `tests/test_agent_mcp_connections.py` verifying MCP connection lifecycle, tool discovery, and execution.
  - Test execution logs of `tests/test_langdock_workspace_agent_mcp.py` verifying workspace-level MCP parity and tool calling.

### 4. Slack Channel
- **Required Evidence:**
  - Test execution logs of `tests/test_emily_slack_channels.py` verifying channel routing, message dispatching, and response delivery.
  - Completed checklist or logs from manual self-testing of the Slack integration using `docs/slack-self-test.md`.
