/**
 * Emily Chat -- Stub conversation data
 *
 * STUB DATA SEAM: This file provides realistic mock messages for visual
 * development. The real data flows from useChatStream (see hook file).
 * Replace STUB_MESSAGES with real SSE-derived state when wiring the backend.
 */

import type { ChatMessage } from "./emily-chat-types";

export const STUB_MESSAGES: ChatMessage[] = [
  {
    id: "1",
    role: "user",
    text: "Hey Emily, create a worker that sends me a weekly digest of my top GitHub PRs every Monday at 9am.",
  },
  {
    id: "2",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "On it. Drafting a **Weekly GitHub Digest** worker for you. It will pull your open PRs every Monday morning and email you a summary.",
      },
      {
        type: "tool-card",
        card: {
          kind: "worker-create",
          callId: "call_001",
          card_id: "card_call_001",
          workerName: "Weekly GitHub Digest",
          workerId: "weekly-github-digest",
          smokeStatus: "passed",
          step: "ready",
          status: "completed",
          actions: [
            { id: "open_worker", label: "Open", href: "/workers?sel=weekly-github-digest" },
            { id: "run_worker", label: "Run now", href: "/workers?sel=weekly-github-digest" },
          ],
        },
      },
    ],
  },
  {
    id: "3",
    role: "user",
    text: "Run it now so I can see what the email looks like.",
  },
  {
    id: "4",
    role: "assistant",
    parts: [
      { type: "text", text: "Running Weekly GitHub Digest now. I will let you know when it completes." },
      {
        type: "tool-card",
        card: {
          kind: "run",
          callId: "call_002",
          card_id: "card_call_002",
          workerName: "Weekly GitHub Digest",
          workerId: "weekly-github-digest",
          runId: "run_abc123",
          duration: "4.2s",
          logLines: 87,
          status: "completed",
          artifact: { name: "weekly-github-digest-2026-06-05.md", id: "art_001" },
          actions: [
            { id: "open_run", label: "View run", href: "/runs/run_abc123" },
            { id: "download", label: "Download", href: "/runs/run_abc123/artifacts/art_001/download" },
          ],
        },
      },
    ],
  },
  {
    id: "5",
    role: "user",
    text: "Create a worker that monitors Stripe for failed payments and pings me on Slack immediately.",
  },
  {
    id: "6",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "To do that, I need access to your Stripe account. Approve the connection below and I will proceed.",
      },
      {
        type: "tool-card",
        card: {
          kind: "approval",
          callId: "call_003",
          card_id: "card_call_003",
          workerName: "Stripe Failure Monitor",
          action: "Connect Stripe and read payment events",
          approved: null,
          brand: "stripe",
          status: "pending_approval",
          actions: [
            { id: "approve", label: "Approve", href: "/runs/run_003/approve", method: "POST" },
            { id: "reject", label: "Deny", href: "/runs/run_003/reject", method: "POST" },
          ],
        },
      },
    ],
  },
  {
    id: "7",
    role: "user",
    text: "Also hook it up to my Gmail to send a backup email.",
  },
  {
    id: "8",
    role: "assistant",
    parts: [
      { type: "text", text: "Connect Gmail first so I can send from your account:" },
      {
        type: "tool-card",
        card: {
          kind: "connect-service",
          callId: "call_004",
          card_id: "card_call_004",
          appName: "gmail",
          label: "Gmail",
          connected: false,
          status: "ready",
          actions: [
            { id: "connect", href: "/connections", method: "POST" },
          ],
        },
      },
    ],
  },
  {
    id: "9",
    role: "user",
    text: "What workers do I currently have?",
  },
  {
    id: "10",
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "You have 3 active workers:\n\n1. **Weekly GitHub Digest** runs every Monday at 9am\n2. **Stripe Failure Monitor** is waiting for your approval\n3. **Daily Standup** posts to Slack at 8:30am on weekdays\n\nAll are healthy. Last run: 4 hours ago.",
      },
      {
        type: "tool-card",
        card: {
          kind: "worker-list",
          callId: "call_005",
          card_id: "card_call_005",
          status: "completed",
          workers: [
            { id: "weekly-github-digest", name: "Weekly GitHub Digest", trigger: "cron: Mon 9am", enabled: true },
            { id: "stripe-failure-monitor", name: "Stripe Failure Monitor", trigger: "webhook: stripe", enabled: false },
            { id: "daily-standup", name: "Daily Standup", trigger: "cron: weekdays 8:30am", enabled: true },
          ],
        },
      },
    ],
  },
];
