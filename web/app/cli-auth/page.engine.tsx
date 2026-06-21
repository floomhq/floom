"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FloomMark } from "@/components/layout/sidebar";

const DEFAULT_CLI_AUTH_ENDPOINT_BASE = "/api/proxy/cli-auth";
const DEFAULT_CLI_CLIENT_NAME = "floom-cli";

export type CliAuthContentProps = {
  endpointBase?: string;
  clientName?: string;
};

// Explicit state machine. A terminal state (approved/denied) NEVER renders the
// action buttons, the security warning, or the code-confirm prompt — only a
// calm "return to your terminal" / "access denied" panel.
type AuthState = "idle" | "approving" | "denying" | "approved" | "denied" | "error";

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
  const [code, setCode] = useState("");
  const [state, setState] = useState<AuthState>("idle");
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    setCode(new URLSearchParams(window.location.search).get("code")?.trim().toUpperCase() || "");
  }, []);

  const busy = state === "approving" || state === "denying";
  const isTerminal = state === "approved" || state === "denied";
  const canAct = Boolean(code) && !busy && !isTerminal;

  async function submit(action: "approve" | "deny") {
    if (!code || busy || isTerminal) return;
    setState(action === "approve" ? "approving" : "denying");
    setErrorText("");
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
        setErrorText(body.detail || "Authorization failed");
        setState("error");
        return;
      }
      // No auto-redirect: land on a clean terminal state so the user can return
      // to their terminal (the engine twin of the cloud-overlay post-approve
      // bounce fix).
      setState(action === "approve" ? "approved" : "denied");
    } catch {
      setErrorText("Could not reach the API.");
      setState("error");
    }
  }

  return (
    // Full-screen standalone gate (AppShell standalonePrefixes), centered like
    // /login: no sidebar chrome, the page IS the single authorize action.
    <div className="grid min-h-screen w-full place-items-center bg-[var(--bg-app)] px-6 py-10 text-[var(--ink)]">
      <div className="w-full max-w-md">
        <div className="rounded-[var(--radius-card)] bg-[var(--bg-card)] px-8 py-9">
          {/* Brand mark — same play-arrow squircle as /login, never a text circle. */}
          <div className="mb-7 flex items-center gap-2.5">
            <FloomMark size={22} />
            <span className="text-sm font-semibold tracking-tight">Floom</span>
          </div>

          {(state === "approved" || state === "denied") ? (
            <TerminalState kind={state} />
          ) : (
            <>
              <h1 className="text-xl font-semibold tracking-tight">Authorize CLI</h1>
              <p className="mt-1.5 text-sm text-[var(--muted-text)]">
                A command-line client is requesting access to your workspace.
              </p>

              <div className="mt-6 space-y-1.5">
                <p className="text-xs font-medium text-[var(--muted-text)]">Confirmation code</p>
                <div className="rounded-[var(--radius-button)] bg-[var(--bg-2)] px-4 py-3">
                  <code className="font-mono text-2xl font-semibold tracking-[0.2em] text-[var(--ink)]">
                    {code || "····"}
                  </code>
                </div>
                <p className="pt-1 text-xs text-[var(--muted-text)]">
                  Client <span className="font-medium text-[var(--ink)]">{clientName}</span>
                </p>
              </div>

              <p className="mt-5 text-xs leading-relaxed text-[var(--muted-text)]">
                Only approve if this code matches the one shown in your terminal. If it
                does not match, deny; someone may be trying to hijack your login.
              </p>

              {state === "error" && errorText && (
                <p className="mt-4 text-sm text-destructive">{errorText}</p>
              )}

              <div className="mt-6 flex gap-2.5">
                <Button
                  size="lg"
                  className="flex-1"
                  disabled={!canAct}
                  onClick={() => void submit("approve")}
                >
                  {state === "approving" ? "Approving..." : "Approve"}
                </Button>
                <Button
                  variant="secondary"
                  size="lg"
                  className="flex-1"
                  disabled={!canAct}
                  onClick={() => void submit("deny")}
                >
                  {state === "denying" ? "Denying..." : "Deny"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TerminalState({ kind }: { kind: "approved" | "denied" }) {
  const approved = kind === "approved";
  return (
    <div className="py-2">
      <div
        className="grid size-11 place-items-center rounded-full"
        style={{
          backgroundColor: approved
            ? "color-mix(in srgb, var(--primary) 12%, transparent)"
            : "color-mix(in srgb, var(--destructive) 12%, transparent)",
        }}
      >
        {approved ? (
          <Check className="size-5 text-[var(--primary)]" aria-hidden />
        ) : (
          <X className="size-5 text-destructive" aria-hidden />
        )}
      </div>
      <h1 className="mt-5 text-xl font-semibold tracking-tight">
        {approved ? "Approved" : "Access denied"}
      </h1>
      <p className="mt-1.5 text-sm text-[var(--muted-text)]">
        {approved
          ? "You can return to your terminal."
          : "The request was rejected. No access was granted."}
      </p>
      <p className="mt-4 text-xs text-[var(--ink-faint)]">You can close this tab.</p>
    </div>
  );
}
