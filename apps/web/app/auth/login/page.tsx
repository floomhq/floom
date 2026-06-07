"use client";

import { FormEvent, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AlertCircle, LogIn } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type LoginResponse = {
  redirect_to?: string;
};

function safeReturnTo(value: string | null): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return null;
  if (value.startsWith("/auth/login")) return null;
  return value;
}

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [returnTo, setReturnTo] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    setReturnTo(safeReturnTo(params.get("return_to")));
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/proxy/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        let detail = "Sign-in failed. Check your username and password.";
        try {
          const body = await res.json();
          if (typeof body.detail === "string") detail = body.detail;
        } catch {
          // Keep the friendly default.
        }
        throw new Error(detail);
      }
      const body = (await res.json()) as LoginResponse;
      router.replace(returnTo || body.redirect_to || "/overview");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-[calc(100vh-96px)] w-full max-w-sm items-center">
      <form
        onSubmit={submit}
        className="w-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] p-5 shadow-sm"
      >
        <div className="mb-5 space-y-1">
          <h1 className="text-xl font-semibold tracking-tight">
            Sign in to your Workeros workspace
          </h1>
          <p className="text-sm text-muted-foreground">
            Use the username and password for this workspace.
          </p>
        </div>

        {error && (
          <Alert variant="destructive" className="mb-4">
            <AlertCircle className="size-4" />
            <AlertTitle>Unable to sign in</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              name="username"
              autoComplete="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              required
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </div>
        </div>

        <Button
          type="submit"
          className="mt-5 w-full"
          disabled={submitting || !username.trim() || !password}
        >
          <LogIn className="size-4" />
          {submitting ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
