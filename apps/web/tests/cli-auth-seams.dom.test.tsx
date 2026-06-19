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

    expect(await screen.findByText("Client: floom-cli")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

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

    expect(await screen.findByText("Client: workeros-cli")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/app/api/cli-auth/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_code: "ABCD-2345" }),
      });
    });
  });
});
