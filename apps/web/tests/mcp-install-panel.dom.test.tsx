import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiMock = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
}));

vi.mock("@/components/connections/BrandLogo", () => ({
  BrandLogo: ({ icon }: { icon: string }) => <span data-testid={`brand-${icon}`} />,
}));

vi.mock("@/lib/api", () => ({
  api: {
    workspace: {
      tokens: {
        list: apiMock.list,
        create: apiMock.create,
      },
    },
  },
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.list.mockResolvedValue([
    {
      id: "wt1",
      name: "existing",
      created_by: "u1",
      created_at: "2026-06-01T00:00:00Z",
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    },
  ]);
  apiMock.create.mockResolvedValue({
    id: "wt2",
    name: "MCP agent install",
    token: "wst_test_token",
    expires_at: null,
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
  });
});

describe("McpInstallPanel", () => {
  it("creates and copies a workspace token from the agent install panel", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { McpInstallPanel } = await import("@/components/mcp/McpInstallPanel");

    render(<McpInstallPanel />);

    expect(await screen.findByText(/Existing tokens: 1/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage tokens" })).toHaveAttribute(
      "href",
      "/settings?sel=workspace_token",
    );

    await user.click(screen.getByRole("button", { name: "Create token" }));

    await waitFor(() => expect(apiMock.create).toHaveBeenCalledWith("MCP agent install"));
    expect(await screen.findByText("wst_test_token")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy token" }));
    expect(writeText).toHaveBeenCalledWith("wst_test_token");
  });
});
