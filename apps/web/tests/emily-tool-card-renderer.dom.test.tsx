import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ToolCardRenderer } from "@/components/emily/cards/ToolCardRenderer";
import type { ToolCard } from "@/lib/emily-chat-types";

const listMock = vi.fn();
const approveAgentTool = vi.fn().mockResolvedValue({});
const rejectAgentTool = vi.fn().mockResolvedValue({});

vi.mock("@/lib/api", () => ({
  api: {
    approvals: {
      list: (...a: unknown[]) => listMock(...a),
      approveAgentTool: (...a: unknown[]) => approveAgentTool(...a),
      rejectAgentTool: (...a: unknown[]) => rejectAgentTool(...a),
      approveAction: vi.fn(),
      rejectAction: vi.fn(),
    },
    runs: { approve: vi.fn(), reject: vi.fn() },
  },
}));

const base = { callId: "call_1", card_id: "card_1", status: "completed" as const };

function card(extra: Partial<ToolCard> & { kind: ToolCard["kind"] }): ToolCard {
  return { ...base, ...extra } as ToolCard;
}

describe("Emily ToolCardRenderer", () => {
  it("renders generic tool calls with the shared collapsible Tool component", async () => {
    render(
      <ToolCardRenderer
        card={card({
          kind: "generic",
          title: "Read brain pack",
          toolName: "contexts.read",
          args: { path: "customer-notes.md" },
          result: { ok: true, content: "ACME renewal notes" },
        } as Partial<ToolCard> & { kind: ToolCard["kind"] })}
      />
    );

    expect(screen.getByText("Read brain pack")).toBeTruthy();
    expect(screen.getByText("call_1")).toBeTruthy();

    await userEvent.click(screen.getByText("Read brain pack"));

    expect(screen.getByText("Args")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
    expect(screen.getByText(/customer-notes\.md/)).toBeTruthy();
    expect(screen.getByText(/ACME renewal notes/)).toBeTruthy();
  });

  it("renders run cards through Tool and keeps the concrete app link", async () => {
    render(
      <ToolCardRenderer
        card={card({
          kind: "run",
          toolName: "runs.get",
          workerName: "Research Brief",
          runId: "run_123",
          args: { run_id: "run_123" },
          result: { ok: true, run: { id: "run_123", status: "completed" } },
        } as Partial<ToolCard> & { kind: ToolCard["kind"] })}
      />
    );

    expect(screen.getByText("Research Brief")).toBeTruthy();
    expect(screen.getByRole("link", { name: /Open in app/i })).toHaveAttribute("href", "/runs/run_123");

    await userEvent.click(screen.getByText("Research Brief"));

    expect(screen.getByText("Args")).toBeTruthy();
    expect(screen.getByText("Result")).toBeTruthy();
    expect(screen.getAllByText(/run_123/).length).toBeGreaterThan(0);
  });

  it("keeps approval cards inline and actionable instead of wrapping them as generic tools", () => {
    render(
      <ToolCardRenderer
        card={card({
          kind: "approval",
          approvalId: "ap_1",
          workerName: "CRM updater",
          action: "Update 3 HubSpot records",
          approved: null,
          status: "pending_approval",
        })}
      />
    );

    expect(screen.getByText("waiting")).toBeTruthy();
    expect(screen.getByText("Approve")).toBeTruthy();
    expect(screen.getByText("Reject")).toBeTruthy();
    expect(screen.queryByText("Args")).toBeNull();
  });
});
