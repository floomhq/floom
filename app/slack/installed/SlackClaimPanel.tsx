"use client";

import { useState } from "react";

type ClaimState = "idle" | "sending" | "verify" | "claimed" | "error";

export function SlackClaimPanel({ claimToken }: { claimToken: string }) {
  const [state, setState] = useState<ClaimState>("idle");
  const [slackUserId, setSlackUserId] = useState("");
  const [code, setCode] = useState("");
  const [message, setMessage] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");

  async function submitClaim(nextCode = "") {
    const cleanSlackUserId = slackUserId.trim();
    if (!cleanSlackUserId) {
      setState("error");
      setMessage("Enter your Slack member ID.");
      return;
    }
    setState("sending");
    setMessage("");
    const response = await fetch("/api/slack/install/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token: claimToken,
        slack_user_id: cleanSlackUserId,
        verification_code: nextCode || undefined,
      }),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      ok?: boolean;
      verification_required?: boolean;
      workspace_id?: string;
      detail?: string;
    };
    if (response.status === 202 || payload.verification_required) {
      setState("verify");
      setMessage("A one-time code was sent in Slack.");
      return;
    }
    if (response.ok && payload.ok) {
      setWorkspaceId(payload.workspace_id ?? "");
      setState("claimed");
      setMessage("Workspace claimed.");
      return;
    }
    setState("error");
    setMessage(payload.detail ?? "Claim failed.");
  }

  if (state === "claimed") {
    return (
      <div className="space-y-4">
        <p className="text-[14px] leading-relaxed text-muted-foreground">{message}</p>
        <a
          href={workspaceId ? `/app/overview?workspace_id=${encodeURIComponent(workspaceId)}` : "/app/overview"}
          className="inline-flex h-11 items-center justify-center rounded-[10px] bg-foreground px-5 text-[14px] font-medium text-background"
        >
          Open app
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {state === "verify" ? (
        <div className="space-y-3">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            The code was sent to Slack member {slackUserId.trim()}.
          </p>
          <label className="block text-[12px] font-medium uppercase tracking-[0.08em] text-muted-foreground" htmlFor="slack-code">
            Slack code
          </label>
          <input
            id="slack-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
            className="h-11 w-full rounded-[10px] border border-border bg-background px-3 text-[16px] outline-none focus:border-foreground"
          />
          <button
            type="button"
            disabled={code.length < 6}
            onClick={() => submitClaim(code)}
            className="inline-flex h-11 items-center justify-center rounded-[10px] bg-foreground px-5 text-[14px] font-medium text-background disabled:cursor-not-allowed disabled:opacity-50"
          >
            Verify and claim
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          <label className="block text-[12px] font-medium uppercase tracking-[0.08em] text-muted-foreground" htmlFor="slack-user-id">
            Slack member ID
          </label>
          <input
            id="slack-user-id"
            value={slackUserId}
            onChange={(event) => setSlackUserId(event.target.value.trim().slice(0, 32))}
            className="h-11 w-full rounded-[10px] border border-border bg-background px-3 text-[16px] outline-none focus:border-foreground"
          />
          <button
            type="button"
            disabled={state === "sending" || !slackUserId.trim()}
            onClick={() => submitClaim()}
            className="inline-flex h-11 items-center justify-center rounded-[10px] bg-foreground px-5 text-[14px] font-medium text-background disabled:cursor-not-allowed disabled:opacity-50"
          >
            {state === "sending" ? "Sending..." : "Send Slack code"}
          </button>
        </div>
      )}
      {message ? (
        <p className={`text-[13px] leading-relaxed ${state === "error" ? "text-red-600" : "text-muted-foreground"}`}>
          {message}
        </p>
      ) : null}
    </div>
  );
}
