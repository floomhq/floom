"use client";

// Standalone preview harness for the real Share modal (round-09 share-real).
// Not part of the product surface: a dev/QA route to screenshot the modal in
// each state without a backend. Each scenario stubs its own create/revoke/
// setVisibility handlers so the full UX (company access, grants, public-link
// state machine, transfer confirmation, revoke confirmation) is exercisable.

import { useEffect, useState } from "react";
import { ShareModal } from "@/components/sharing/ShareModal";
import type { AssetVisibility } from "@/lib/types";

// Preview-only: stub the grants endpoint so the worker/brain scenarios don't hit
// the (absent) backend, 401, and trigger the global redirect-to-login. Returns a
// fixed sample roster so the people-with-access list renders. Scoped to
// /share/grants GET only; everything else passes through.
function usePreviewGrantsStub() {
  useEffect(() => {
    const real = window.fetch;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      const method = (init?.method ?? "GET").toUpperCase();
      if (url.includes("/share/grants") && method === "GET") {
        return new Response(
          JSON.stringify([{ id: "g1", email: "morten@example.com", created_at: "" }]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return real(input, init);
    };
    return () => {
      window.fetch = real;
    };
  }, []);
}

const SAMPLE_URL = "https://localhost:3000/s/fls_8x2Kp9QvA3mWnZ7tLrYbHd4";

// A public-link create() that resolves to a fixed sample URL so screenshots are
// stable. revoke() resolves after a tick.
function sampleLink() {
  return {
    create: async () => SAMPLE_URL,
    revoke: async () => {
      await new Promise((r) => setTimeout(r, 50));
    },
  };
}

type Scenario = {
  key: string;
  label: string;
  Component: (props: { open: boolean; onOpenChange: (v: boolean) => void }) => React.ReactNode;
};

function Worker({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [visibility, setVisibility] = useState<AssetVisibility>("private");
  return (
    <ShareModal
      open={open}
      onOpenChange={onOpenChange}
      asset={{ type: "worker", name: "Candidate Matcher" }}
      companyAccess={{
        visibility,
        setVisibility: async (v) => {
          setVisibility(v);
          return v;
        },
        grantAsset: { type: "worker", id: "candidate-matcher" },
      }}
      publicLink={sampleLink()}
    />
  );
}

function Run({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <ShareModal
      open={open}
      onOpenChange={onOpenChange}
      asset={{ type: "run", name: "Candidate Matcher" }}
      publicLink={sampleLink()}
    />
  );
}

function BrainPack({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const [visibility, setVisibility] = useState<AssetVisibility>("workspace");
  return (
    <ShareModal
      open={open}
      onOpenChange={onOpenChange}
      asset={{ type: "brain_pack", name: "Hiring playbook" }}
      companyAccess={{
        visibility,
        setVisibility: async (v) => {
          setVisibility(v);
          return v;
        },
        grantAsset: { type: "brain", id: "hiring-playbook" },
      }}
      publicLink={sampleLink()}
    />
  );
}

function Approval({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  return (
    <ShareModal
      open={open}
      onOpenChange={onOpenChange}
      asset={{ type: "approval", name: "Send outreach to 12 leads" }}
      publicLink={{
        create: async () => SAMPLE_URL,
        staticUrl: `${SAMPLE_URL}?id=appr_42&token=hmac`,
        label: "Decision link",
      }}
    />
  );
}

const SCENARIOS: Scenario[] = [
  { key: "worker", label: "Worker", Component: Worker },
  { key: "run", label: "Run", Component: Run },
  { key: "brain_pack", label: "Brain pack", Component: BrainPack },
  { key: "approval", label: "Approval", Component: Approval },
];

export default function ShareModalPreview() {
  usePreviewGrantsStub();
  const [active, setActive] = useState<string | null>(null);
  return (
    <div className="mx-auto max-w-2xl p-10">
      <h1 className="text-lg font-medium text-[var(--ink)]">Share modal preview harness</h1>
      <p className="mt-1 text-sm text-[var(--ink-mute)]">
        Open each scenario. Worker shows company access + grants + transfer confirmation +
        public link. Run is public-link only. Brain pack mirrors worker. Approval is a static
        decision link (no revoke).
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        {SCENARIOS.map((s) => (
          <button
            key={s.key}
            type="button"
            data-testid={`open-${s.key}`}
            className="c-addbtn"
            onClick={() => setActive(s.key)}
          >
            {s.label}
          </button>
        ))}
      </div>
      {SCENARIOS.map((s) => {
        const C = s.Component;
        return (
          <C
            key={s.key}
            open={active === s.key}
            onOpenChange={(v) => setActive(v ? s.key : null)}
          />
        );
      })}
    </div>
  );
}
