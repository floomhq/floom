"use client";

export const dynamic = "force-dynamic";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

const DEFAULT_CLI_AUTH_ENDPOINT_BASE = "/api/proxy/cli-auth";
const DEFAULT_CLI_CLIENT_NAME = "floom-cli";

export type CliAuthContentProps = {
  endpointBase?: string;
  clientName?: string;
};

function cliAuthEndpoint(endpointBase: string, action: "approve" | "deny") {
  return `${endpointBase.replace(/\/$/, "")}/${action}`;
}

export default function CliAuthPage() {
  return <CliAuthContent />;
}

export function CliAuthContent({
  endpointBase = DEFAULT_CLI_AUTH_ENDPOINT_BASE,
  clientName = DEFAULT_CLI_CLIENT_NAME,
}: CliAuthContentProps = {}) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busyAction, setBusyAction] = useState<"approve" | "deny" | null>(null);
  const [statusText, setStatusText] = useState("");

  useEffect(() => {
    setCode(new URLSearchParams(window.location.search).get("code")?.trim().toUpperCase() || "");
  }, []);

  const canApprove = Boolean(code);
  const canDeny = Boolean(code);

  async function submit(action: "approve" | "deny") {
    if (!code) return;
    setBusyAction(action);
    setStatusText("");
    try {
      const response = await fetch(cliAuthEndpoint(endpointBase, action), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ user_code: code }),
      });
      const body = (await response.json().catch(() => ({}))) as { detail?: string };
      if (!response.ok) {
        setStatusText(body.detail || "Authorization failed");
        return;
      }
      if (action === "approve") {
        setStatusText("✓ Approved. You can return to your terminal.");
        setTimeout(() => {
          router.push("/");
        }, 3000);
      } else {
        setStatusText("Request denied.");
      }
    } catch {
      setStatusText("Could not reach the API.");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    // Full-screen standalone gate (AppShell standalonePrefixes), centered like
    // /login: no sidebar chrome, the page IS the single authorize action.
    <div className="min-h-screen grid place-items-center bg-[var(--bg-app)] px-6 py-10 text-[var(--ink)]">
      <div className="w-full max-w-xl space-y-6">
        {/* S29s: dropped Card wrapper. The page IS the action; a card around
            a short form added nothing. Heading + content sit flat. */}
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Authorize CLI</h1>
          <p className="text-sm text-muted-foreground mt-1">A CLI is requesting access.</p>
        </div>
        <div className="space-y-4 text-sm">
          <p>
            Code: <code className="bg-muted px-1.5 py-0.5 font-mono">{code || "(missing)"}</code>
          </p>
          <p>Client: {clientName}</p>
          <p className="text-xs text-muted-foreground">
            Only approve if this code matches the one shown in your terminal. If it
            does not match, deny: someone may be trying to hijack your login.
          </p>
          <div className="flex gap-2">
            <Button
              disabled={!canApprove || busyAction !== null}
              onClick={() => void submit("approve")}
            >
              {busyAction === "approve" ? "Approving..." : "Approve"}
            </Button>
            <Button
              variant="secondary"
              disabled={!canDeny || busyAction !== null}
              onClick={() => void submit("deny")}
            >
              {busyAction === "deny" ? "Denying..." : "Deny"}
            </Button>
          </div>
          {statusText && <p className="text-sm">{statusText}</p>}
        </div>
      </div>
    </div>
  );
}
