"use client";

import { FormEvent, useState } from "react";
import { appUrl } from "@/lib/app-url";

async function postAuth(endpoint: string, payload: unknown): Promise<Response> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Network error");
}

export function normalizeNextPath(value: string): string {
  let next = value || "/app";
  for (let depth = 0; depth < 3; depth += 1) {
    try {
      const url = new URL(next, "https://workeros.floom.dev");
      if (url.pathname !== "/login" && url.pathname !== "/app/login") {
        return `${url.pathname}${url.search}${url.hash}`;
      }
      const nested = url.searchParams.get("next");
      if (!nested) return "/app";
      next = nested;
    } catch {
      return "/app";
    }
  }
  return "/app";
}

export function LoginEmailPanel({ next }: { next: string }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<"magic" | "password">("magic");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    setStatus(null);
    setError(null);
    try {
      const normalizedNext = normalizeNextPath(next);
      const endpoint = mode === "magic" ? "/api/auth/email" : "/api/auth/password";
      const response = await postAuth(endpoint, { email, password, next: normalizedNext });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.detail === "string" ? body.detail : "Sign-in failed");
      }
      if (mode === "password") {
        window.location.replace(appUrl(normalizeNextPath(body.next || normalizedNext || "/")));
        return;
      }
      setStatus("Check your email for the magic link.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="mt-4 space-y-3" onSubmit={submit}>
      <div className="grid grid-cols-2 rounded-[12px] bg-[var(--bg-2)] p-1">
        <button
          type="button"
          onClick={() => setMode("magic")}
          className={`h-8 rounded-[9px] text-[13px] font-medium transition-colors ${
            mode === "magic" ? "bg-card text-foreground" : "text-muted-foreground"
          }`}
        >
          Magic link
        </button>
        <button
          type="button"
          onClick={() => setMode("password")}
          className={`h-8 rounded-[9px] text-[13px] font-medium transition-colors ${
            mode === "password" ? "bg-card text-foreground" : "text-muted-foreground"
          }`}
        >
          Password
        </button>
      </div>

      <label className="block">
        <span className="sr-only">Email</span>
        <input
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          autoComplete="email"
          required
          placeholder="you@company.com"
          className="h-11 w-full rounded-[12px] bg-secondary px-3 text-sm transition-colors placeholder:text-muted-foreground focus:bg-card"
        />
      </label>

      {mode === "password" ? (
        <label className="block">
          <span className="sr-only">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
            placeholder="Password"
            className="h-11 w-full rounded-[12px] bg-secondary px-3 text-sm transition-colors placeholder:text-muted-foreground focus:bg-card"
          />
        </label>
      ) : null}

      <button
        type="submit"
        disabled={loading}
        className="flex h-11 w-full items-center justify-center rounded-[12px] bg-foreground px-4 text-[14px] font-medium text-background transition hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Sending..." : mode === "magic" ? "Email me a magic link" : "Sign in with password"}
      </button>

      {status ? <p className="text-center text-[12px]" style={{ color: "var(--v3-accent)" }}>{status}</p> : null}
      {error ? <p className="text-center text-[12px] text-[var(--warning)]">{error}</p> : null}
    </form>
  );
}
