// FIX1: a single Emily run that fires many tool calls must NOT render a wall of
// repeated tool-call rows. Consecutive non-interactive tool-call cards collapse
// into one "N tool calls" summary (collapsed by default), expandable to show the
// individual cards; a failed call is surfaced in the summary ("· M failed") and
// never silently hidden inside the count. Approval cards stay inline/actionable.
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ToolCard } from "@/lib/emily-chat-types";

function genericCard(n: number, status: "completed" | "failed" = "completed"): ToolCard {
  return {
    kind: "generic",
    callId: `call_${n}`,
    card_id: `card_${n}`,
    status,
    toolName: "worker-author",
    title: "worker-author",
    args: { step: n },
    result: { ok: status === "completed" },
  } as ToolCard;
}

function workerCreateCard(): ToolCard {
  return {
    kind: "worker-create",
    callId: "call_create",
    card_id: "card_create",
    status: "running",
    title: "Creating worker",
    workerName: "Creating worker",
    step: "drafting",
    streams: { events: "/runs/run_author_123/events", parts: "/runs/run_author_123/stream" },
  } as ToolCard;
}

let toolParts: ToolCard[] = [];

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock("@/lib/useChatStream", () => ({
  getAutoOpenRunDetailsHref: vi.fn(),
  getStreamingActivity: vi.fn(() => ({ kind: "idle" })),
  shouldAutoOpenRunDetails: vi.fn(() => false),
  // #1992: EmilyChat now imports decideRunAutoOpen; this full mock must export it
  // (skip = no auto-open, matching shouldAutoOpenRunDetails → false above).
  decideRunAutoOpen: vi.fn(() => ({ action: "skip" })),
  getCardHref: vi.fn(() => null),
  getToolCardTitle: vi.fn((name: string) => name),
  useChatStream: () => ({
    messages: [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Creating your worker." },
          ...toolParts.map((card) => ({ type: "tool-card", card })),
          { type: "text", text: "Done — your Stripe alert worker is ready." },
        ],
      },
    ],
    conversationId: "c1",
    isStreaming: false,
    isHydrating: false,
    error: null,
    sendMessage: vi.fn(),
    newSession: vi.fn(),
    loadConversation: vi.fn(),
  }),
}));

vi.mock("@/lib/api", () => ({
  api: { conversations: { list: vi.fn().mockResolvedValue([]) } },
}));

describe("Emily tool-call consolidation (FIX1)", () => {
  it("collapses many consecutive tool calls into one 'N tool calls' summary, expandable on click", async () => {
    toolParts = Array.from({ length: 14 }, (_, i) => genericCard(i + 1));
    const user = userEvent.setup();
    const { EmilyChatPage } = await import("@/components/emily/EmilyChat");
    render(<EmilyChatPage />);

    // The final assistant text stays visible.
    expect(screen.getByText("Done — your Stripe alert worker is ready.")).toBeTruthy();

    // Summary line shows the count; raw Args/Result JSON is NOT dumped inline.
    const summary = screen.getByRole("button", { name: /14 tool calls/i });
    expect(summary).toBeTruthy();
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Args")).toBeNull();

    // Expanding reveals the individual cards.
    await user.click(summary);
    expect(summary.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("worker-author").length).toBe(14);
  });

  it("surfaces a failed call in the summary instead of hiding it in the count", async () => {
    toolParts = [
      genericCard(1),
      genericCard(2, "failed"),
      genericCard(3),
    ];
    const { EmilyChatPage } = await import("@/components/emily/EmilyChat");
    render(<EmilyChatPage />);

    const summary = screen.getByRole("button", { name: /3 tool calls/i });
    expect(summary).toBeTruthy();
    // Failure is flagged in the collapsed summary.
    expect(summary.textContent).toMatch(/1 failed/i);
  });

  it("keeps worker-create progress inline instead of hiding it inside a tool-call group", async () => {
    toolParts = [
      genericCard(1),
      workerCreateCard(),
      genericCard(2),
    ];
    const { EmilyChatPage } = await import("@/components/emily/EmilyChat");
    render(<EmilyChatPage />);

    expect(screen.queryByRole("button", { name: /3 tool calls/i })).toBeNull();
    expect(screen.getAllByText("Creating worker").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Drafting manifest")).toBeTruthy();
  });
});
