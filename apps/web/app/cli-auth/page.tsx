"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const API_BASE = process.env.NEXT_PUBLIC_FLOOM_API_BASE || "https://workers-api.floom.dev";
const SECRET_STORAGE_KEYS = ["floom_secret", "FLOOM_SECRET", "workeros_api_secret"];

function readStoredSecret(): string {
  if (typeof window === "undefined") return "";
  for (const key of SECRET_STORAGE_KEYS) {
    const value = window.localStorage.getItem(key);
    if (value && value.trim()) return value.trim();
  }
  return "";
}

export default function CliAuthPage() {
  return (
    <Suspense fallback={<CliAuthFallback />}>
      <CliAuthContent />
    </Suspense>
  );
}

function CliAuthFallback() {
  return (
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Authorize CLI</h1>
      <Card>
        <CardContent className="pt-6 text-sm text-muted-foreground">Loading authorization request...</CardContent>
      </Card>
    </div>
  );
}

function CliAuthContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const code = useMemo(() => (searchParams.get("code") || "").trim().toUpperCase(), [searchParams]);

  const [secret, setSecret] = useState("");
  const [busyAction, setBusyAction] = useState<"approve" | "deny" | null>(null);
  const [statusText, setStatusText] = useState("");

  useEffect(() => {
    setSecret(readStoredSecret());
  }, []);

  const canApprove = Boolean(secret) && Boolean(code);

  async function submit(action: "approve" | "deny") {
    if (!code || !secret) return;
    setBusyAction(action);
    setStatusText("");
    try {
      const response = await fetch(`${API_BASE}/cli-auth/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-floom-secret": secret,
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
    <div className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Authorize CLI</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">A CLI is requesting access</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <p>
            Code: <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{code || "(missing)"}</code>
          </p>
          <p>Client: floom-cli</p>
          {!secret && (
            <p className="text-muted-foreground">
              Sign in first. Paste your secret in <Link className="underline" href="/settings">Settings</Link>, then reload this page.
            </p>
          )}
          <div className="flex gap-2">
            <Button
              disabled={!canApprove || busyAction !== null}
              onClick={() => void submit("approve")}
            >
              {busyAction === "approve" ? "Approving..." : "Approve"}
            </Button>
            <Button
              variant="secondary"
              disabled={!canApprove || busyAction !== null}
              onClick={() => void submit("deny")}
            >
              {busyAction === "deny" ? "Denying..." : "Deny"}
            </Button>
          </div>
          {statusText && <p className="text-sm">{statusText}</p>}
        </CardContent>
      </Card>
    </div>
  );
}
