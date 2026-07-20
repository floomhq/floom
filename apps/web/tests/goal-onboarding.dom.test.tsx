import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { push, importFromPermalink, setActiveWorkspaceId } = vi.hoisted(() => ({
  push: vi.fn(),
  importFromPermalink: vi.fn(),
  setActiveWorkspaceId: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/useWorkspaceHref", () => ({
  useWorkspaceHref: () => (href: string) => href,
}));

vi.mock("@/lib/api", () => ({
  api: { workers: { importFromPermalink } },
  setActiveWorkspaceId,
}));

vi.mock("@/lib/api-base", () => ({
  getPublicSiteOrigin: () => "https://floom.dev",
}));

import { GOAL_LANES, GoalOnboarding } from "@/components/home/GoalOnboarding";

beforeEach(() => {
  push.mockReset();
  importFromPermalink.mockReset();
  setActiveWorkspaceId.mockReset();
});

describe("goal-based first-open onboarding", () => {
  it("uses the shared button system for all five CTA implementations", () => {
    const source = readFileSync(
      path.join(process.cwd(), "components/home/GoalOnboarding.tsx"),
      "utf8",
    );
    expect(source.match(/<Button\b/g)).toHaveLength(4);
    expect(source).toContain("className={buttonVariants({");
    expect(source).not.toMatch(/<button\b/);
  });

  it("maps every lane to a real live-gallery template", () => {
    expect(GOAL_LANES.map((lane) => [lane.title, lane.template.slug])).toEqual([
      ["Outreach & Leads", "partnership-signal-outreach"],
      ["Inbox & Comms", "gmail-inbox-cleaner"],
      ["Research", "meeting-prep"],
      ["Reports & Dev", "slack-weekly-recap"],
    ]);
  });

  it("asks one question, then makes sample data primary and connection secondary", async () => {
    const user = userEvent.setup();
    render(<GoalOnboarding />);

    expect(screen.getAllByText(/\?$/)).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /Outreach & Leads/i }));

    expect(screen.getByRole("heading", { name: "Partnership Signal & Outreach" })).toBeInTheDocument();
    expect(screen.getByText("Prefilled template")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "See it with sample data first" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Connect LinkedIn" })).toHaveAttribute(
      "href",
      "/connections/connect/linkedin?return_to=%2F",
    );
  });

  it("shows a clearly labeled sample result before importing", async () => {
    const user = userEvent.setup();
    render(<GoalOnboarding />);

    await user.click(screen.getByRole("button", { name: /Inbox & Comms/i }));
    await user.click(screen.getByRole("button", { name: "See it with sample data first" }));

    expect(screen.getByRole("heading", { name: "First sample run complete" })).toBeInTheDocument();
    expect(screen.getByText("Sample data, no external tools used")).toBeInTheDocument();
    expect(screen.getByText("Scanned 14 sample emails")).toBeInTheDocument();
    expect(importFromPermalink).not.toHaveBeenCalled();
  });

  it("imports the selected permalink template and continues to the real run page", async () => {
    importFromPermalink.mockResolvedValue({ worker_id: "worker-42", workspace_id: "workspace-7" });
    const user = userEvent.setup();
    render(<GoalOnboarding />);

    await user.click(screen.getByRole("button", { name: /Reports & Dev/i }));
    await user.click(screen.getByRole("button", { name: "See it with sample data first" }));
    await user.click(screen.getByRole("button", { name: "Add to workspace and continue" }));

    expect(importFromPermalink).toHaveBeenCalledWith("fede", "slack-weekly-recap");
    expect(setActiveWorkspaceId).toHaveBeenCalledWith("workspace-7");
    expect(push).toHaveBeenCalledWith("/run/worker-42");
  });

  it("keeps import failures in context and allows retry", async () => {
    importFromPermalink.mockRejectedValue(new Error("Template import failed"));
    const user = userEvent.setup();
    render(<GoalOnboarding />);

    await user.click(screen.getByRole("button", { name: /Research/i }));
    await user.click(screen.getByRole("button", { name: "See it with sample data first" }));
    await user.click(screen.getByRole("button", { name: "Add to workspace and continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Template import failed");
    expect(screen.getByRole("button", { name: "Add to workspace and continue" })).toBeEnabled();
  });
});
