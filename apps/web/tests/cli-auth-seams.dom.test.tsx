import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CliAuthContent } from "@/app/cli-auth/page";

describe("CLI auth seams", () => {
  beforeEach(() => {
    window.history.pushState({}, "", "/cli-auth?code=ABCD-2345");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({}),
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

  it("enters the approved terminal state with the brand line and hides the action buttons", async () => {
    render(<CliAuthContent />);

    fireEvent.click(await screen.findByRole("button", { name: "Approve & connect" }));

    // Terminal success state carries the brand line + close-tab nod.
    expect(await screen.findByText("Your agents are connected")).toBeInTheDocument();
    expect(screen.getByText(/close this tab/i)).toBeInTheDocument();

    // Action buttons + security note + code prompt + Details are GONE — no branch
    // renders both the success text and the approve action simultaneously.
    expect(screen.queryByRole("button", { name: "Approve & connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
    expect(screen.queryByText(/only approve if this matches/i)).toBeNull();
    expect(screen.queryByText("Confirmation code")).toBeNull();
    expect(screen.queryByRole("button", { name: "Details" })).toBeNull();
  });

  it("enters the denied terminal state and hides the action buttons", async () => {
    render(<CliAuthContent />);

    fireEvent.click(await screen.findByRole("button", { name: "Deny" }));

    expect(await screen.findByText("Request denied")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approve & connect" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("surfaces an error and stays on the idle action state for retry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
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

  it("keeps secondary trust info under a collapsed Details toggle (progressive disclosure)", async () => {
    render(
      <CliAuthContent
        details={[
          { label: "Device", value: "MacBook Pro" },
          { label: "Scopes", value: "Full workspace access" },
        ]}
      />
    );

    // Collapsed by default — the approve click is never blocked by trust detail.
    expect(await screen.findByRole("button", { name: "Approve & connect" })).toBeInTheDocument();
    expect(screen.queryByText("MacBook Pro")).toBeNull();
    expect(screen.queryByText("Full workspace access")).toBeNull();

    // Expanding reveals injected device / scopes and a revoke note.
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("MacBook Pro")).toBeInTheDocument();
    expect(screen.getByText("Full workspace access")).toBeInTheDocument();
    expect(screen.getByText(/revoke this access/i)).toBeInTheDocument();
  });
});
