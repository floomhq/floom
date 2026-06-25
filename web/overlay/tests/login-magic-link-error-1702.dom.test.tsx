import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";

// #1702: a failed/expired/consumed magic link redirects to /login?error=<code>.
// The login page must surface a human message + the normal re-login form,
// instead of the previous raw {"detail":"Auth callback failed"} JSON dead-end.

vi.mock("@/components/layout/sidebar", () => ({ FloomMark: () => null }));

async function renderLoginPage(search = "") {
  const { default: LoginPage } = await import("@/app/login/page");
  const searchParams = Object.fromEntries(new URLSearchParams(search).entries());
  render(await LoginPage({ searchParams: Promise.resolve(searchParams) }));
}

describe("Login magic-link error surfacing (#1702)", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, json: async () => ({ required: false }) }),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows a human message for ?error=expired_link", async () => {
    await renderLoginPage("error=expired_link");
    expect(
      await screen.findByText(/This sign-in link expired or was already used\. Request a new one below\./),
    ).toBeInTheDocument();
    // The re-login form is still present (recovery path).
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeInTheDocument();
  });

  it("shows a human message for ?error=account_disabled", async () => {
    await renderLoginPage("error=account_disabled");
    expect(
      await screen.findByText(/This account has been disabled\. Contact your workspace admin\./),
    ).toBeInTheDocument();
  });

  it("falls back to a generic message for an unknown error code", async () => {
    await renderLoginPage("error=something_weird");
    expect(
      await screen.findByText(/Could not sign you in\. Please try again\./),
    ).toBeInTheDocument();
  });

  it("shows no error banner when there is no ?error param", async () => {
    await renderLoginPage();
    await screen.findByRole("heading", { name: "Welcome back" });
    expect(screen.queryByText(/Could not sign you in/)).not.toBeInTheDocument();
    expect(screen.queryByText(/This sign-in link expired/)).not.toBeInTheDocument();
  });
});
