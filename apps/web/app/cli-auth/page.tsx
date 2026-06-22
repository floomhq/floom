"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

const DEFAULT_CLI_AUTH_ENDPOINT_BASE = "/api/proxy/cli-auth";
const DEFAULT_CLI_CLIENT_NAME = "floom-cli";

export type CliAuthDetail = { label: string; value: string };

export type CliAuthContentProps = {
  endpointBase?: string;
  clientName?: string;
  // Optional secondary trust info (device / account / scopes / expiry). Rendered
  // only when the host injects it — never fabricated. Lives under "Details".
  details?: CliAuthDetail[];
};

// Explicit state machine. A terminal state (approved/denied) NEVER renders the
// action buttons, the security note, the code-confirm prompt, or Details — only
// a calm, brand-carrying "your agents are connected" / "request denied" panel.
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
  details,
}: CliAuthContentProps = {}) {
  const [code, setCode] = useState("");
  const [state, setState] = useState<AuthState>("idle");
  const [errorText, setErrorText] = useState("");
  const [showDetails, setShowDetails] = useState(false);

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

  const detailRows: CliAuthDetail[] = [{ label: "Client", value: clientName }, ...(details ?? [])];

  return (
    // Full-screen standalone gate (AppShell standalonePrefixes), centered like
    // /login: no sidebar chrome, the page IS the single authorize action.
    <div className="grid min-h-screen w-full place-items-center bg-[var(--bg-app)] px-6 py-10 text-[var(--ink)]">
      <div className="w-full max-w-md">
        <div className="rounded-[var(--radius-card)] bg-[var(--bg-card)] px-8 py-9">
          {(state === "approved" || state === "denied") ? (
            <TerminalState kind={state} />
          ) : (
            <>
              {/* Aspirational animated hero — the brand moment, not a text headline. */}
              <ConstellationHero />

              <div className="mt-6 text-center">
                <h1 className="text-xl font-semibold tracking-tight">
                  Your AI workers, one command away
                </h1>
                <p className="mt-1.5 text-sm text-[var(--muted-text)]">
                  Approve this device to connect{" "}
                  <span className="font-medium text-[var(--ink)]">{clientName}</span> to your
                  workspace.
                </p>
              </div>

              <div className="mt-6 space-y-1.5">
                <p className="text-xs font-medium text-[var(--muted-text)]">Confirmation code</p>
                <div className="grid place-items-center rounded-[var(--radius-button)] bg-[var(--bg-2)] px-4 py-3">
                  <code className="font-mono text-2xl font-semibold tracking-[0.2em] text-[var(--ink)]">
                    {code || "····"}
                  </code>
                </div>
                <p className="pt-1 text-center text-xs text-[var(--muted-text)]">
                  Approve only if this matches the code shown in your terminal.
                </p>
              </div>

              {state === "error" && errorText && (
                <p className="mt-4 text-center text-sm text-destructive">{errorText}</p>
              )}

              {/* Low friction: ONE big primary action, deny is a quiet secondary. */}
              <Button
                size="lg"
                className="mt-6 w-full"
                disabled={!canAct}
                onClick={() => void submit("approve")}
              >
                {state === "approving" ? "Connecting…" : "Approve & connect"}
              </Button>

              <div className="mt-2.5 text-center">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!canAct}
                  onClick={() => void submit("deny")}
                >
                  {state === "denying" ? "Denying…" : "Deny"}
                </Button>
              </div>

              {/* Progressive disclosure: device / account / scopes / expiry / revoke
                  collapsed by default so they never block the approve click. */}
              <div className="mt-5 [border-top:var(--bd-div)] pt-4">
                <button
                  type="button"
                  aria-expanded={showDetails}
                  onClick={() => setShowDetails((v) => !v)}
                  className="flex w-full items-center justify-between text-xs font-medium text-[var(--muted-text)] transition-colors hover:text-[var(--ink)]"
                >
                  Details
                  <ChevronDown
                    className={`size-3.5 transition-transform duration-200 ${showDetails ? "rotate-180" : ""}`}
                    aria-hidden
                  />
                </button>
                {showDetails && (
                  <dl className="mt-3 space-y-2 text-xs">
                    {detailRows.map((row) => (
                      <div key={row.label} className="flex items-baseline justify-between gap-4">
                        <dt className="text-[var(--muted-text)]">{row.label}</dt>
                        <dd className="text-right font-medium text-[var(--ink)]">{row.value}</dd>
                      </div>
                    ))}
                    <p className="pt-1 text-[var(--ink-faint)]">
                      You can revoke this access anytime from Settings.
                    </p>
                  </dl>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// Agent-constellation hero: agent nodes orbit the Floom play-arrow mark, a pulse
// of light travels each connection line into the center. `connected` swaps the
// living orbit for a settled, lit-up "all connected" composition (success state).
const HERO_NODES = [
  { x: 160, y: 30, delay: "0s" },
  { x: 92, y: 60, delay: "0.7s" },
  { x: 112, y: 124, delay: "1.4s" },
  { x: 208, y: 124, delay: "2.1s" },
  { x: 228, y: 60, delay: "2.8s" },
];

function ConstellationHero({ connected = false }: { connected?: boolean }) {
  return (
    <div className="relative w-full overflow-hidden rounded-[var(--radius-button)]">
      <svg
        viewBox="0 0 320 160"
        className="block w-full"
        role="img"
        aria-label={
          connected ? "Your agents are connected to Floom" : "Floom connecting your AI agents"
        }
      >
        <defs>
          <radialGradient id="cliHeroGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.16" />
            <stop offset="60%" stopColor="var(--accent)" stopOpacity="0.05" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </radialGradient>
        </defs>

        <rect x="0" y="0" width="320" height="160" fill="url(#cliHeroGlow)" />

        <g className={connected ? undefined : "floom-cli-orbit"}>
          {/* faint orbit rings */}
          <ellipse cx="160" cy="80" rx="92" ry="48" fill="none" stroke="var(--line)" strokeWidth="1" />
          <ellipse cx="160" cy="80" rx="60" ry="30" fill="none" stroke="var(--line-soft)" strokeWidth="1" />

          {/* resting connection lines */}
          {HERO_NODES.map((n, i) => (
            <line
              key={`line-${i}`}
              x1="160"
              y1="80"
              x2={n.x}
              y2={n.y}
              stroke="var(--accent)"
              strokeOpacity={connected ? 0.55 : 0.18}
              strokeWidth="1"
            />
          ))}

          {/* traveling pulse along each line (idle only) */}
          {!connected &&
            HERO_NODES.map((n, i) => (
              <line
                key={`beam-${i}`}
                x1={n.x}
                y1={n.y}
                x2="160"
                y2="80"
                stroke="var(--accent)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeDasharray="5 85"
                className="floom-cli-beam"
                style={{ animationDelay: n.delay }}
              />
            ))}

          {/* agent nodes */}
          {HERO_NODES.map((n, i) => (
            <g
              key={`node-${i}`}
              className={connected ? undefined : "floom-cli-breathe"}
              style={{ animationDelay: n.delay }}
            >
              <circle
                cx={n.x}
                cy={n.y}
                r="4.5"
                fill="var(--bg-card)"
                stroke="var(--accent)"
                strokeWidth="1.5"
                strokeOpacity={connected ? 1 : 0.85}
              />
              {connected && <circle cx={n.x} cy={n.y} r="2" fill="var(--accent)" />}
            </g>
          ))}
        </g>

        {/* central halo */}
        <circle
          cx="160"
          cy="80"
          r="28"
          fill="var(--accent)"
          fillOpacity={connected ? 0.12 : 0.08}
          className={connected ? undefined : "floom-cli-halo"}
        />
        {connected && (
          <circle cx="160" cy="80" r="27" fill="none" stroke="var(--success)" strokeWidth="2" />
        )}

        {/* central Floom mark — the black squircle + offset white play-arrow */}
        <g transform="translate(140 60) scale(0.4)">
          <rect width="100" height="100" rx="22" fill="var(--primary)" />
          <path
            d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
            fill="var(--bg-card)"
          />
        </g>
      </svg>
    </div>
  );
}

function TerminalState({ kind }: { kind: "approved" | "denied" }) {
  const approved = kind === "approved";

  if (approved) {
    return (
      <div className="text-center">
        {/* Same brand moment, now settled: the constellation is connected. */}
        <ConstellationHero connected />
        <h1 className="mt-6 text-xl font-semibold tracking-tight">Your agents are connected</h1>
        <p className="mt-1.5 text-sm text-[var(--muted-text)]">
          Head back to your terminal. Floom is wired in and ready to run.
        </p>
        <p className="mt-4 inline-flex items-center gap-1.5 text-xs text-[var(--ink-faint)]">
          <Check className="size-3.5 text-[var(--success)]" aria-hidden />
          You can close this tab.
        </p>
      </div>
    );
  }

  return (
    <div className="py-2">
      <div className="mb-7 flex items-center gap-2.5">
        <svg width={22} height={22} viewBox="0 0 100 100" aria-hidden style={{ borderRadius: "22%" }}>
          <rect width="100" height="100" rx="22" fill="var(--primary)" />
          <path
            d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
            fill="var(--bg-app)"
          />
        </svg>
        <span className="text-sm font-semibold tracking-tight">Floom</span>
      </div>
      <h1 className="text-xl font-semibold tracking-tight">Request denied</h1>
      <p className="mt-1.5 text-sm text-[var(--muted-text)]">
        No access was granted. If this was you, run the command again to get a new code.
      </p>
      <p className="mt-4 text-xs text-[var(--ink-faint)]">You can close this tab.</p>
    </div>
  );
}
