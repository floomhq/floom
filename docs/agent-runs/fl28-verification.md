# FL28: Full Worker Setup and Emily Verification (UI, MCP, WhatsApp, Slack)

This document records the verification status, required evidence, and concrete next steps for the full worker-setup flow and Emily across all four supported channels: UI, MCP, WhatsApp, and Slack.

> **PR Status Note:** This PR is explicitly **non-closing** for issue #524. The actual code fix for issue #524 cannot be inferred from the available context, and the PR is currently in a blocked state pending further requirements and concrete code changes.

## Verification Status Summary

| Channel | Status | Evidence / Verification Method | Notes / Defects |
| --- | --- | --- | --- |
| **UI** | Pending Verification | Requires CI execution logs of `apps/web/tests/new-worker-emily-902.dom.test.tsx` and manual end-to-end testing screenshots. | Evidence of UI flow execution is required. |
| **WhatsApp** | Pending Verification | Requires live sandbox testing logs using the Twilio/WhatsApp API and webhook integration test outputs. | Evidence of webhook routing is required. |
| **MCP (Model Context Protocol)** | Pending Verification | Requires test run outputs of `tests/test_agent_mcp_connections.py` and `tests/test_langdock_workspace_agent_mcp.py`. | Evidence of tool discovery and execution is required. |
| **Slack** | Pending Verification | Requires test run outputs of `tests/test_emily_slack_channels.py` and manual self-test logs following `docs/slack-self-test.md`. | Evidence of Slack event routing is required. |

## Detailed Verification Steps & Required Evidence

### 1. UI Channel
- **E2E Flow:** User navigates to the worker creation wizard, configures a new worker with Emily, and initiates a chat session.
- **Required Evidence:** 
  - CI execution logs for DOM tests in `apps/web/tests/new-worker-emily-902.dom.test.tsx` and `apps/web/tests/new-worker-emily-chat-only.dom.test.tsx`.
  - Test run outputs for chat streaming and scroll lock verified by `apps/web/tests/fl-scroll-lock.test.ts`.

### 2. WhatsApp Channel
- **E2E Flow:** Incoming WhatsApp messages trigger the webhook, which routes the message to Emily, processes the response, and sends it back to the user.
- **Required Evidence:**
  - Webhook signature verification and message parsing test outputs.
  - Live sandbox run logs or webhook delivery receipts.

### 3. MCP Channel
- **E2E Flow:** Emily connects to external tools via Model Context Protocol (MCP) hosts, lists available tools, and executes them within the agent session.
- **Required Evidence:**
  - Test execution logs of `tests/test_agent_mcp_connections.py` verifying MCP connection lifecycle, tool discovery, and execution.
  - Test execution logs of `tests/test_langdock_workspace_agent_mcp.py` verifying workspace-level MCP parity and tool calling.

### 4. Slack Channel
- **E2E Flow:** Slack events (app mentions, direct messages) are received by the Slack events router, dispatched to Emily, and responses are posted back to the corresponding Slack channel.
- **Required Evidence:**
  - Test execution logs of `tests/test_emily_slack_channels.py` verifying channel routing, message dispatching, and response delivery.
  - Completed checklist or logs from manual self-testing of the Slack integration using `docs/slack-self-test.md`.

## Next Steps & Continuous Verification
1. Obtain the necessary context and requirements to implement the actual code fix for issue #524.
2. Run the automated test suite and capture the outputs to satisfy the evidence requirements:
   - `pytest tests/test_agent_mcp_connections.py`
   - `pytest tests/test_emily_slack_channels.py`
3. Perform manual verification of the Slack app using the manifest template in `docs/slack-app-manifest.example.yml` and document the run outputs.
