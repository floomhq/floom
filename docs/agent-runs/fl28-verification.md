# FL28: Blocked State and Verification Requirements for Issue #524

## PR Status: BLOCKED & NON-CLOSING

This PR is explicitly **non-closing** and **does not** resolve issue #524. The code changes required to address issue #524 cannot be inferred from the available context. No code changes have been implemented, and the PR remains in a **BLOCKED** state.

## Verification Status: UNVERIFIED

- **No verification has been performed.**
- **No tests have been executed.**
- **No verification claims are made in this PR.**
- All verification channels are currently marked as **Pending** and **Unverified**.

## Concrete Evidence Requirements (Required for Future Fix)

Before any future PR addressing issue #524 can be merged, the following concrete evidence must be produced and verified:

### 1. UI Channel Requirements
- **Required Evidence:**
  - Complete, successful CI execution logs for DOM tests in `apps/web/tests/new-worker-emily-902.dom.test.tsx` and `apps/web/tests/new-worker-emily-chat-only.dom.test.tsx`.
  - Successful test run outputs for chat streaming and scroll lock verified by `apps/web/tests/fl-scroll-lock.test.ts`.

### 2. WhatsApp Channel Requirements
- **Required Evidence:**
  - Webhook signature verification and message parsing test outputs.
  - Live sandbox run logs or webhook delivery receipts.

### 3. MCP Channel Requirements
- **Required Evidence:**
  - Test execution logs of `tests/test_agent_mcp_connections.py` verifying MCP connection lifecycle, tool discovery, and execution.
  - Test execution logs of `tests/test_langdock_workspace_agent_mcp.py` verifying workspace-level MCP parity and tool calling.

### 4. Slack Channel Requirements
- **Required Evidence:**
  - Test execution logs of `tests/test_emily_slack_channels.py` verifying channel routing, message dispatching, and response delivery.
  - Completed checklist or logs from manual self-testing of the Slack integration using `docs/slack-self-test.md`.
