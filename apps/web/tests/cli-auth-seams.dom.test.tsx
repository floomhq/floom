import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CliAuthContent, cliAuthLoginRedirect } from "@/app/cli-auth/page";

describe("CLI auth seams", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/cli-auth?code=ABCD-2345");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "application/json" },
        json: async () => ({ ok: true }),
      })
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps the OSS endpoint and client name by default", async () => {
    render(<CliAuthContent />);

    expect(await screen.findByText("floom-cli")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve & connect" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/proxy/cli-auth/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_code: "ABCD-2345" }),
      });
    });
  });

  it("uses injected cloud endpoint base and CLI client name", async () => {
    render(<CliAuthContent endpointBase="/app/api/cli-auth/" clientName="workeros-cli" />);

    expect(await screen.findByText("workeros-cli")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve & connect" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/app/api/cli-auth/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_code: "ABCD-2345" }),
      });
    });
  });

  it("enters the approved terminal state and hides the action buttons", async () => {
    render(<CliAuthContent />);

    fireEvent.click(await screen.findByRole("button", { name: "Approve & connect" }));

    // Terminal success state shows.
    expect(await screen.findByText("Your agents are connected")).toBeInTheDocument();
    expect(
      screen.getByText("You can return to your terminal.")
    ).toBeInTheDocument();

    // Action buttons + warning + code prompt are GONE — no branch renders both
    // the success text and the Approve button simultaneously.
    expect(screen.queryByRole("button", { name: "Approve & connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.queryByText(/hijack your login/i)).toBeNull();
    expect(screen.queryByText("Confirmation code")).toBeNull();
  });

  it("enters the denied terminal state and hides the action buttons", async () => {
    render(<CliAuthContent />);

    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

    expect(await screen.findByText("Access denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("surfaces an error and stays on the idle action state for retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        headers: { get: () => "application/json" },
        json: async () => ({ detail: "Code expired" }),
      })
    );
    render(<CliAuthContent />);

    fireEvent.click(await screen.findByRole("button", { name: "Approve & connect" }));

    expect(await screen.findByText("Code expired")).toBeInTheDocument();
    // Buttons remain available for retry.
    expect(screen.getByRole("button", { name: "Approve & connect" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Deny" })).toBeInTheDocument();
  });

  it("redirects logged-out approval attempts to login with the CLI code preserved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ detail: "Authentication required." }),
      })
    );
    const assign = vi.fn();
    Object.defineProperty(window, "location", {
      value: { ...window.location, assign },
      writable: true,
    });
    render(<CliAuthContent loginPath="/login" />);

    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(assign).toHaveBeenCalledWith("/login?next=%2Fcli-auth%3Fcode%3DABCD-2345");
    });
  });

  it("builds a login redirect that preserves the CLI code", () => {
    expect(cliAuthLoginRedirect("/app/login")).toBe(
      "/app/login?next=%2Fcli-auth%3Fcode%3DABCD-2345",
    );
  });
});
