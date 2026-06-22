import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/connections",
}));

const gmail = {
  id: "c-gmail",
  app_name: "gmail",
  status: "active",
  created_at: "2026-06-19T10:00:00Z",
  updated_at: "2026-06-19T10:00:00Z",
  display_name: "Gmail",
  account_label: "ops@floom.dev",
  scopes: ["gmail.readonly", "gmail.send"],
  owner_id: null,
  kind: "composio",
};

const listConnections = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    workers: { list: vi.fn().mockResolvedValue([]) },
    connections: {
      list: (...args: unknown[]) => listConnections(...args),
      delete: vi.fn(),
      test: vi.fn().mockResolvedValue({ status: "valid", reason: "", tested_at: "" }),
      peek: vi.fn().mockResolvedValue({ emails: [] }),
      activity: vi.fn().mockResolvedValue([]),
      tools: vi.fn().mockResolvedValue({ tools: [] }),
      toolPresets: vi.fn().mockResolvedValue({ app: "gmail", tools: ["gmail.readonly"] }),
    },
    secrets: { list: vi.fn().mockResolvedValue([]), upsert: vi.fn(), test: vi.fn(), delete: vi.fn() },
    members: { list: vi.fn().mockResolvedValue({ members: [] }) },
  },
}));

function TestQueryProvider({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function classIncludes(el: Element, value: string): boolean {
  return typeof el.getAttribute("class") === "string" && el.getAttribute("class")!.includes(value);
}

function greyCardWrappers(scope: Element): Element[] {
  return Array.from(scope.querySelectorAll("*")).filter((el) =>
    classIncludes(el, "bg-[var(--bg-2)]") &&
    classIncludes(el, "rounded-[var(--radius-card)]")
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  listConnections.mockResolvedValue([gmail]);
});

describe("Connections detail redesign register", () => {
  it("renders OAuth overview with elevated status/action, kit groups, chips, and no grey wrapper", async () => {
    const { default: ConnectionsCollection } = await import("@/app/connections/ConnectionsCollection");
    render(
      <TestQueryProvider>
        <ConnectionsCollection initialConnections={[gmail as never]} />
      </TestQueryProvider>,
    );

    fireEvent.click(await screen.findByText(/^Gmail$/));

    await waitFor(() => expect(document.querySelector(".c-dhead")).toBeTruthy());

    const header = document.querySelector(".c-dhead")!;
    const status = header.querySelector(".c-pill.ok");
    expect(status?.textContent).toContain("Connected");
    expect(screen.getByRole("link", { name: /^Reconnect$/ })).toHaveAttribute(
      "href",
      "/connections/connect/gmail?return_to=%2Fconnections",
    );

    const body = document.querySelector(".c-dbody");
    expect(body).toBeTruthy();
    expect(body!.querySelectorAll(".c-dgrp").length).toBeGreaterThanOrEqual(3);
    expect(body!.querySelector(".c-drow")).toBeTruthy();
    expect(body!.querySelector(".c-d2")).toBeTruthy();
    expect(body!.querySelectorAll(".c-dchip").length).toBeGreaterThanOrEqual(3);
    const groupLabels = Array.from(body!.querySelectorAll(".c-dgl")).map((el) => el.textContent);
    expect(groupLabels).toEqual(expect.arrayContaining(["Access", "Activity", "Owner"]));
    expect(screen.getByText("gmail.readonly")).toBeInTheDocument();
    expect(screen.getByText("gmail.send")).toBeInTheDocument();
    expect(screen.getByText("+ manage scopes")).toBeInTheDocument();

    expect(
      greyCardWrappers(body!).map((el) => ({
        className: el.getAttribute("class"),
        text: el.textContent?.replace(/\s+/g, " ").trim().slice(0, 120),
      })),
    ).toHaveLength(0);
  });
});
