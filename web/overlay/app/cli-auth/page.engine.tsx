"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FloomMark } from "@/components/layout/sidebar";

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
const DEFAULT_CLI_AUTH_ENDPOINT_BASE = `${BASE_PATH}/api/proxy/cli-auth`;
const DEFAULT_CLI_CLIENT_NAME = "floom-cli";

export type CliAuthContentProps = {
  endpointBase?: string;
  clientName?: string;
  loginPath?: string;
  sessionCheckPath?: string;
};

type AuthState = "idle" | "approving" | "denying" | "approved" | "denied" | "error";

function cliAuthEndpoint(endpointBase: string, action: "approve" | "deny") {
  return `${endpointBase.replace(/\/$/, "")}/${action}`;
}

export function cliAuthLoginRedirect(loginPath: string): string {
  const next = `${window.location.pathname}${window.location.search}`;
  return `${loginPath}?next=${encodeURIComponent(next)}`;
}

export default function CliAuthPage() {
  return <CliAuthContent />;
}

export function CliAuthContent({
  endpointBase = DEFAULT_CLI_AUTH_ENDPOINT_BASE,
  clientName = DEFAULT_CLI_CLIENT_NAME,
  loginPath = "/login",
  sessionCheckPath,
}: CliAuthContentProps = {}) {
  const [code, setCode] = useState("");
  const [state, setState] = useState<AuthState>("idle");
  const [errorText, setErrorText] = useState("");

  useEffect(() => {
    setCode(new URLSearchParams(window.location.search).get("code")?.trim().toUpperCase() || "");
  }, []);

  useEffect(() => {
    if (!sessionCheckPath) return;
    let cancelled = false;
    async function checkSession() {
      try {
        const response = await fetch(sessionCheckPath as string, {
          headers: { Accept: "application/json" },
          cache: "no-store",
        });
        const body = (await response.json().catch(() => ({}))) as { user?: unknown };
        if (!cancelled && (!response.ok || !body.user)) {
          window.location.assign(cliAuthLoginRedirect(loginPath));
        }
      } catch {
        if (!cancelled) {
          window.location.assign(cliAuthLoginRedirect(loginPath));
        }
      }
    }
    void checkSession();
    return () => {
      cancelled = true;
    };
  }, [loginPath, sessionCheckPath]);

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
      const contentType = response.headers.get("content-type") || "";
      const isJson = contentType.toLowerCase().includes("application/json");
      const body = (isJson ? await response.json().catch(() => ({})) : {}) as { ok?: boolean; detail?: string };
      if (!response.ok) {
        if (response.status === 401) {
          window.location.assign(cliAuthLoginRedirect(loginPath));
          return;
        }
        setErrorText(body.detail || "Authorization failed");
        setState("error");
        return;
      }
      if (!isJson || body.ok !== true) {
        window.location.assign(cliAuthLoginRedirect(loginPath));
        return;
      }
      setState(action === "approve" ? "approved" : "denied");
    } catch {
      setErrorText("Could not reach the API.");
      setState("error");
    }
  }

  return (
    <div className="min-h-screen w-full bg-[var(--bg-app)] px-5 py-8 text-[var(--ink)]">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-[520px] items-center justify-center">
        <main className="w-full rounded-[var(--radius-card)] bg-[var(--bg-card)] px-6 py-7 shadow-[var(--shadow-card)] sm:px-8 sm:py-8">
          <div className="mb-7 flex items-center gap-2.5" aria-label="Floom">
            <FloomMark size={24} />
            <span className="text-sm font-semibold tracking-tight">Floom</span>
          </div>

          {isTerminal ? (
            <TerminalState kind={state} />
          ) : (
            <>
              <h1 className="text-2xl font-semibold tracking-tight">Authorize CLI</h1>
              <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
                Confirm this code to connect the Floom CLI to your account.
              </p>

              <div className="mt-7 space-y-2">
                <p className="text-xs font-medium text-[var(--ink-mute)]">Confirmation code</p>
                <div
                  className="rounded-[var(--radius-button)] bg-[var(--bg-2)] px-4 py-5"
                  aria-label="Confirmation code"
                >
                  <code className="block text-center font-mono text-2xl font-semibold tracking-[0.18em] text-[var(--ink)]">
                    {code || "...."}
                  </code>
                </div>
              </div>

              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                <Button
                  size="lg"
                  className="h-11 w-full bg-[var(--primary)] text-[var(--primary-text)] hover:bg-[color-mix(in_srgb,var(--primary)_88%,black_12%)] focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-card)]"
                  disabled={!canAct}
                  onClick={() => void submit("approve")}
                >
                  {state === "approving" ? "Approving..." : "Approve"}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  variant="outline"
                  className="h-11 w-full focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-card)]"
                  disabled={!canAct}
                  onClick={() => void submit("deny")}
                >
                  {state === "denying" ? "Denying..." : "Deny"}
                </Button>
              </div>

              <p className="mt-4 text-xs leading-5 text-[var(--ink-mute)]">
                <span className="font-medium text-[var(--warning)]">Caution:</span> approve only if this code matches
                the one shown in your terminal.
              </p>

              {state === "error" && errorText && (
                <p className="mt-4 text-sm text-[var(--warning)]" role="alert">{errorText}</p>
              )}

              <details className="group mt-5 rounded-[var(--radius-button)] bg-[var(--bg-2)] px-4 py-3">
                <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-[var(--ink)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-2)]">
                  Details
                  <ChevronDown className="size-4 text-[var(--ink-mute)] transition-transform group-open:rotate-180" aria-hidden />
                </summary>
                <dl className="mt-3 grid gap-2 text-xs leading-5 text-[var(--ink-soft)]">
                  <div className="flex items-center justify-between gap-3">
                    <dt>Device</dt>
                    <dd className="font-medium text-[var(--ink)]">{clientName}</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt>Account</dt>
                    <dd className="font-medium text-[var(--ink)]">Current workspace user</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt>Scopes</dt>
                    <dd className="font-medium text-[var(--ink)]">CLI access</dd>
                  </div>
                  <div className="flex items-center justify-between gap-3">
                    <dt>Expiry</dt>
                    <dd className="font-medium text-[var(--ink)]">Short lived</dd>
                  </div>
                </dl>
              </details>
            </>
          )}
        </main>
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
            ? "color-mix(in srgb, #3563CC 12%, transparent)"
            : "color-mix(in srgb, #C98A1A 12%, transparent)",
        }}
      >
        {approved ? (
          <Check className="size-5 text-[#3563CC]" aria-hidden />
        ) : (
          <X className="size-5 text-[#C98A1A]" aria-hidden />
        )}
      </div>
      <h1 className="mt-5 text-xl font-semibold tracking-tight">
        {approved ? "CLI authorized" : "Access denied"}
      </h1>
      <p className="mt-1.5 text-sm text-[var(--ink-soft)]">
        {approved
          ? "You can return to your terminal."
          : "The request was rejected. No access was granted."}
      </p>
      <p className="mt-4 text-xs text-[#8A929D]">You can close this tab.</p>
    </div>
  );
}
