"use client";

import { FormEvent, useState } from "react";

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
      const endpoint = mode === "magic" ? "/api/auth/email" : "/api/auth/password";
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password, next }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(typeof body.detail === "string" ? body.detail : "Sign-in failed");
      }
      if (mode === "password") {
        window.location.replace(body.next || next || "/app");
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
      <div className="grid grid-cols-2 rounded-[var(--radius-button)] border border-[var(--line)] bg-[var(--paper-2)] p-1">
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
          onClick={() => setMode("password")}
          className={`h-8 rounded-[calc(var(--radius-button)-4px)] text-[13px] font-medium transition-colors ${
            mode === "password" ? "bg-[var(--paper)] text-[var(--ink)] shadow-sm" : "text-[var(--ink-soft)]"
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
          className="h-11 w-full rounded-[var(--radius-input)] border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none transition-colors placeholder:text-[var(--ink-mute)] focus:border-[var(--ink-soft)]"
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
            className="h-11 w-full rounded-[var(--radius-input)] border border-[var(--line)] bg-[var(--paper)] px-3 text-sm outline-none transition-colors placeholder:text-[var(--ink-mute)] focus:border-[var(--ink-soft)]"
          />
        </label>
      ) : null}

      <button
        type="submit"
        disabled={loading}
        className="auth-btn auth-btn-secondary w-full disabled:cursor-not-allowed disabled:opacity-60"
      >
        {loading ? "Sending..." : mode === "magic" ? "Email me a magic link" : "Sign in with password"}
      </button>

      {status ? <p className="text-center text-[12px] text-[var(--success)]">{status}</p> : null}
      {error ? <p className="text-center text-[12px] text-[var(--warning)]">{error}</p> : null}
    </form>
  );
}
