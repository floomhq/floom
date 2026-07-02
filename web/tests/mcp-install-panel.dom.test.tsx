import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const apiMock = vi.hoisted(() => ({
  workspaceList: vi.fn(),
  workspaceCreate: vi.fn(),
  personalList: vi.fn(),
}));

vi.mock("@/components/connections/BrandLogo", () => ({
  BrandLogo: ({ icon }: { icon: string }) => <span data-testid={`brand-${icon}`} />,
}));

vi.mock("@/lib/api", () => ({
  api: {
    tokens: {
      list: apiMock.personalList,
    },
    workspace: {
      tokens: {
        list: apiMock.workspaceList,
        create: apiMock.workspaceCreate,
      },
    },
  },
}));

vi.mock("@/lib/useWorkspaceHref", () => ({
  useWorkspaceHref: () => (href: string) => `/app${href}`,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.personalList.mockResolvedValue([
    {
      id: "pt1",
      name: "personal-cli",
      created_at: "2026-06-01T00:00:00Z",
      last_used_at: null,
      expires_at: null,
      revoked_at: null,
    },
  ]);
  apiMock.workspaceList.mockResolvedValue([
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
  apiMock.workspaceCreate.mockResolvedValue({
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
  it("surfaces personal and workspace tokens while explaining MCP login", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { McpInstallPanel } = await import("@/components/mcp/McpInstallPanel");

    render(<McpInstallPanel />);

    expect(await screen.findByText(/MCP setup uses your saved CLI login/i)).toBeInTheDocument();
    expect(screen.getByText(/same saved login as the CLI/i)).toBeInTheDocument();
    expect(screen.getByText("floom login")).toBeInTheDocument();
    expect(await screen.findByText(/Personal tokens/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Existing tokens: 1/i)).toHaveLength(2);
    const manageLinks = screen.getAllByRole("link", { name: "Manage" });
    expect(manageLinks[0]).toHaveAttribute(
      "href",
      "/app/settings?sel=personal_tokens",
    );
    expect(screen.getByText(/Workspace tokens/i)).toBeInTheDocument();
    expect(manageLinks[1]).toHaveAttribute(
      "href",
      "/app/settings?sel=workspace_token",
    );

    await user.click(screen.getByRole("button", { name: "Create workspace token" }));

    await waitFor(() => expect(apiMock.workspaceCreate).toHaveBeenCalledWith("MCP agent install"));
    expect(await screen.findByText("wst_test_token")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Copy token" }));
    expect(writeText).toHaveBeenCalledWith("wst_test_token");
  });
});
