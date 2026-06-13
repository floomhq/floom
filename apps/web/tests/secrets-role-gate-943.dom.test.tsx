// #943 — /connections/secrets exposes secret names + worker mappings; the
// inventory must be owner/admin-only. Members get a restricted notice and the
// secrets list call is never made.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const meMock = vi.fn();
const secretsListMock = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/connections/secrets",
}));

vi.mock("@/lib/api", () => ({
  api: {
    me: (...a: unknown[]) => meMock(...a),
    secrets: {
      list: (...a: unknown[]) => secretsListMock(...a),
      upsert: vi.fn(),
      delete: vi.fn(),
      test: vi.fn(),
    },
  },
}));

import SecretsPage from "@/app/connections/secrets/page";

beforeEach(() => {
  meMock.mockReset();
  secretsListMock.mockReset();
  secretsListMock.mockResolvedValue([]);
});

describe("#943 secrets page role gate", () => {
  it("members: restricted notice, NO secrets fetch", async () => {
    meMock.mockResolvedValue({ user_id: "u1", role: "member", is_admin: false });
    render(<SecretsPage />);
    await waitFor(() => {
      expect(
        screen.getByText(/restricted to workspace owners and admins/i),
      ).toBeInTheDocument();
    });
    expect(secretsListMock).not.toHaveBeenCalled();
  });

  it("admins: inventory loads", async () => {
    meMock.mockResolvedValue({ user_id: "u1", role: "admin", is_admin: true });
    secretsListMock.mockResolvedValue([
      {
        name: "ANTHROPIC_API_KEY",
        configured: true,
        used_by: ["Worker A"],
      },
    ]);
    render(<SecretsPage />);
    await waitFor(() => {
      expect(secretsListMock).toHaveBeenCalled();
    });
    expect(
      screen.queryByText(/restricted to workspace owners and admins/i),
    ).not.toBeInTheDocument();
  });

  it("single-tenant (no role field): treated as owner, inventory loads", async () => {
    meMock.mockResolvedValue({ user_id: "u1" });
    render(<SecretsPage />);
    await waitFor(() => {
      expect(secretsListMock).toHaveBeenCalled();
    });
  });

  it("fails closed when /me errors", async () => {
    meMock.mockRejectedValue(new Error("network"));
    render(<SecretsPage />);
    await waitFor(() => {
      expect(
        screen.getByText(/restricted to workspace owners and admins/i),
      ).toBeInTheDocument();
    });
    expect(secretsListMock).not.toHaveBeenCalled();
  });
});
