"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";
import { ChevronDown, ShieldCheck, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { FloomMark } from "@/components/layout/sidebar";

const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/$/, "");
const DEFAULT_CLI_AUTH_ENDPOINT_BASE = `${BASE_PATH}/api/proxy/cli-auth`;
const DEFAULT_CLI_CLIENT_NAME = "floom-cli";

export type CliAuthContentProps = {
  endpointBase?: string;
  clientName?: string;
  loginPath?: string;
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
        setErrorText("You are not logged in to the account that can approve this CLI request. Sign in and try again.");
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
    <div className="min-h-screen w-full bg-[#FBFBFC] px-5 py-8 text-[#16171A]">
      <div className="mx-auto flex min-h-[calc(100vh-4rem)] w-full max-w-5xl items-center justify-center">
        <div className="grid w-full overflow-hidden rounded-[16px] bg-white shadow-[0_24px_80px_hsl(220_18%_18%/.12)] md:grid-cols-[1.08fr_.92fr]">
          <CliAuthHero />
          <main className="px-6 py-7 sm:px-9 sm:py-10">
            <div className="mb-7 flex items-center gap-2.5">
              <FloomMark size={22} />
              <span className="text-sm font-semibold tracking-tight">Floom</span>
            </div>

            {isTerminal ? (
              <TerminalState kind={state} />
            ) : (
              <>
                <h1 className="text-2xl font-semibold tracking-tight">Connect your agents</h1>
                <p className="mt-2 text-sm leading-6 text-[#5C6470]">
                  Match the code from your terminal, then approve this device.
                </p>

                <div className="mt-7 space-y-2">
                  <p className="text-xs font-medium text-[#68707C]">Confirmation code</p>
                  <div className="rounded-[10px] bg-[#F3F5F8] px-4 py-4">
                    <code className="block text-center font-mono text-2xl font-semibold tracking-[0.18em] text-[#16171A]">
                      {code || "...."}
                    </code>
                  </div>
                </div>

                <details className="group mt-4 rounded-[10px] bg-[#F8F9FB] px-4 py-3">
                  <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-medium text-[#31363D]">
                    Details
                    <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
                  </summary>
                  <div className="mt-3 grid gap-2 text-xs leading-5 text-[#5C6470]">
                    <div className="flex items-center justify-between gap-3">
                      <span>Client</span>
                      <span className="font-medium text-[#16171A]">{clientName}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Account</span>
                      <span className="font-medium text-[#16171A]">Current workspace user</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Access</span>
                      <span className="font-medium text-[#16171A]">CLI token for this account</span>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <span>Revoke</span>
                      <span className="font-medium text-[#16171A]">Settings tokens</span>
                    </div>
                  </div>
                </details>

                <div className="mt-5 flex items-start gap-2 rounded-[10px] bg-[#FFF8EA] px-3.5 py-3 text-xs leading-5 text-[#7A560F]">
                  <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[#C98A1A]" />
                  <span>Only approve if this code matches your terminal.</span>
                </div>

                {state === "error" && errorText && (
                  <p className="mt-4 text-sm text-[#9A5E00]">{errorText}</p>
                )}

                <div className="mt-7 space-y-3">
                  <Button
                    size="lg"
                    className="h-12 w-full bg-[#16171A] text-white hover:bg-[#2B2D31]"
                    disabled={!canAct}
                    onClick={() => void submit("approve")}
                  >
                    {state === "approving" ? "Approving..." : "Approve & connect"}
                  </Button>
                  <button
                    type="button"
                    className="mx-auto block text-sm font-medium text-[#68707C] transition-colors hover:text-[#16171A] disabled:opacity-50"
                    disabled={!canAct}
                    onClick={() => void submit("deny")}
                  >
                    {state === "denying" ? "Denying..." : "Deny"}
                  </button>
                </div>
              </>
            )}
          </main>
        </div>
      </div>
    </div>
  );
}

function CliAuthHero() {
  return (
    <section className="relative hidden min-h-[620px] overflow-hidden bg-[#F5F7FB] px-10 py-10 md:block" aria-hidden>
      <div className="absolute inset-x-10 top-10 h-44 rounded-[16px] bg-[#16171A] shadow-[0_20px_60px_hsl(220_22%_10%/.22)]">
        <div className="flex h-9 items-center gap-2 px-4 shadow-[inset_0_-1px_0_rgb(255_255_255/.10)]">
          <span className="size-2 rounded-full bg-[#C98A1A]" />
          <span className="size-2 rounded-full bg-white/30" />
          <span className="size-2 rounded-full bg-white/30" />
        </div>
        <div className="space-y-3 px-5 py-5 font-mono text-[12px] leading-none text-white/72">
          <div>$ floom login</div>
          <div className="text-white">ABCD-2345</div>
          <div className="h-2 w-40 animate-pulse rounded-[10px] bg-[#3563CC]" />
        </div>
      </div>
      <div className="absolute left-1/2 top-[206px] h-44 w-px -translate-x-1/2 bg-gradient-to-b from-[#3563CC] via-[#3563CC] to-transparent" />
      <div className="absolute inset-x-12 bottom-12 rounded-[16px] bg-white p-6 shadow-[0_18px_70px_hsl(220_18%_18%/.10)]">
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="grid size-9 place-items-center rounded-[10px] bg-[#16171A] text-white">
              <Terminal className="size-4" />
            </div>
            <div>
              <div className="h-2.5 w-24 rounded-[10px] bg-[#16171A]" />
              <div className="mt-2 h-2 w-32 rounded-[10px] bg-[#D9DEE7]" />
            </div>
          </div>
          <div className="h-7 w-16 rounded-[10px] bg-[#3563CC]" />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div className="h-20 rounded-[10px] bg-[#F3F5F8]" />
          <div className="h-20 rounded-[10px] bg-[#EEF3FF]" />
          <div className="h-20 rounded-[10px] bg-[#F8F9FB]" />
        </div>
      </div>
    </section>
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
        {approved ? "Your agents are connected" : "Access denied"}
      </h1>
      <p className="mt-1.5 text-sm text-[#5C6470]">
        {approved
          ? "You can return to your terminal."
          : "The request was rejected. No access was granted."}
      </p>
      <p className="mt-4 text-xs text-[#8A929D]">You can close this tab.</p>
    </div>
  );
}
