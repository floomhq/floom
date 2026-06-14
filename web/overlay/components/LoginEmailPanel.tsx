"use client";

import { FormEvent, useState } from "react";

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

function normalizeNextPath(value: string): string {
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

type AuthMode = "magic" | "signin" | "signup";

export function LoginEmailPanel({ next, initialMode = "magic" }: { next: string; initialMode?: AuthMode }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState<AuthMode>(initialMode);
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
      const endpoint = mode === "magic" ? "/app/api/auth/email" : "/app/api/auth/password";
      const response = await postAuth(endpoint, { email, password, next: normalizedNext, mode });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.detail === "string" ? body.detail : "Sign-in failed");
      }
      if (mode === "signin" || body.ok) {
        window.location.replace(normalizeNextPath(body.next || normalizedNext || "/app"));
        return;
      }
      if (mode === "signup" && body.status === "confirmation_required") {
        setStatus("Check your email to confirm your Floom account.");
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
      <div className="grid grid-cols-3 rounded-[var(--radius-button)] border border-[var(--line)] bg-[var(--paper-2)] p-1">
        <button
          type="button"
          onClick={() => setMode("magic")}
          className={`h-8 rounded-[calc(var(--radius-button)-4px)] text-[13px] font-medium transition-colors ${
            mode === "magic" ? "bg-[var(--paper)] text-[var(--ink)] shadow-sm" : "text-[var(--ink-soft)]"
          }`}
        >
          Magic link
        </button>
        <button
          type="button"
          onClick={() => setMode("signin")}
          className={`h-8 rounded-[calc(var(--radius-button)-4px)] text-[13px] font-medium transition-colors ${
            mode === "signin" ? "bg-[var(--paper)] text-[var(--ink)] shadow-sm" : "text-[var(--ink-soft)]"
          }`}
        >
          Sign in
        </button>
        <button
          type="button"
          onClick={() => setMode("signup")}
          className={`h-8 rounded-[calc(var(--radius-button)-4px)] text-[13px] font-medium transition-colors ${
            mode === "signup" ? "bg-[var(--paper)] text-[var(--ink)] shadow-sm" : "text-[var(--ink-soft)]"
          }`}
        >
          Sign up
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
          className="h-11 w-full rounded-[var(--radius-input)] border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none transition-colors placeholder:text-[var(--ink-mute)] focus:border-[var(--ink-soft)]"
        />
      </label>

      {mode !== "magic" ? (
        <label className="block">
          <span className="sr-only">Password</span>
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete={mode === "signup" ? "new-password" : "current-password"}
            required
            placeholder="Password"
            className="h-11 w-full rounded-[var(--radius-input)] border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none transition-colors placeholder:text-[var(--ink-mute)] focus:border-[var(--ink-soft)]"
          />
        </label>
      ) : null}

      <button
        type="submit"
        disabled={loading}
        className="auth-btn auth-btn-secondary w-full disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading
          ? "Sending..."
          : mode === "magic"
            ? "Email me a magic link"
            : mode === "signup"
              ? "Create account"
              : "Sign in with password"}
      </button>

      {status ? <p className="text-center text-[12px] text-[var(--success)]">{status}</p> : null}
      {error ? <p className="text-center text-[12px] text-[var(--warning)]">{error}</p> : null}
    </form>
  );
}
