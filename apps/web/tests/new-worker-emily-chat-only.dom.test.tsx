// Federico 2026-06-19: "The bespoke 'Hire a new worker' screen should not exist!
// Consistent Emily chat." Create is now visually the SAME as the home empty
// state — greeting + pills (EmilyHomeEmpty) ABOVE a CENTERED real composer — NOT
// a bespoke create-worker hero. This test pins create-mode to that consistency:
//   - it renders the home empty state (greeting + pills), no "Hire a new worker"
//     heading, no "ADD SOURCES"/source pills, no create-specific example pills
//   - the composer is the real PromptInput (a <textarea>), centered, with the
//     generic "Message Emily…" placeholder (consistent with home)
//   - clicking a home pill primes that SAME composer
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

// EmilyHomeEmpty reads the overview/workers hooks — stub so it renders the
// active-workspace empty state (greeting + ACTIVE_PILLS) without a QueryClient.
vi.mock("@/lib/query/hooks", () => ({
  useOverview: () => ({
    data: { stats: { work_shipped_7d: 7 }, outcomes: [], recent_runs: [], scheduled_today: [], needs_attention: [] },
    isError: false,
    isLoading: false,
  }),
  useWorkers: () => ({
    data: [{ id: "w1", archived: false, system: false, is_example: false }],
    isError: false,
    isLoading: false,
  }),
}));

vi.mock("@/lib/api", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    api: {
      ...(mod.api as Record<string, unknown>),
      me: vi.fn().mockResolvedValue({ display_name: "Fede", email: "fede@floom.dev" }),
      contexts: { list: vi.fn().mockResolvedValue([]) },
      chat: { uploadAttachments: vi.fn().mockResolvedValue([]) },
      conversations: { list: vi.fn().mockResolvedValue([]) },
    },
  };
});

vi.mock("@/lib/useChatStream", async (importOriginal) => {
  const mod = await importOriginal<Record<string, unknown>>();
  return {
    ...mod,
    useChatStream: () => ({
      messages: [],
      conversationId: null,
      isStreaming: false,
      isHydrating: false,
      error: null,
      sendMessage: vi.fn(),
      newSession: vi.fn(),
      loadConversation: vi.fn(),
    }),
  };
});

import { EmilyChatCore } from "@/components/emily/EmilyChat";

afterEach(() => {
  window.localStorage.clear();
});

describe("new worker = the consistent Emily empty state (no bespoke hero)", () => {
  it("does NOT render the bespoke 'Hire a new worker' screen", () => {
    render(<EmilyChatCore fullPage createMode />);
    expect(screen.queryByRole("heading", { name: "Hire a new worker" })).not.toBeInTheDocument();
    // No bespoke create chrome: no ADD SOURCES row, no create-specific examples.
    expect(screen.queryByText(/Add sources/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Score new CRM contacts against a job brief/i)).not.toBeInTheDocument();
  });

  it("renders the two real activation paths + assistant-helper pills", async () => {
    render(<EmilyChatCore fullPage createMode />);
    expect(await screen.findByText(/Add another worker/i)).toBeInTheDocument();
    // PRIMARY: template gallery. SECONDARY: coding-agent / MCP.
    expect(screen.getByRole("link", { name: /Browse templates/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Set up in your coding agent/i })).toBeInTheDocument();
    // Helper prompts (the assistant guides; it does NOT build the worker here).
    expect(screen.getByRole("button", { name: /Which template fits my team/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /What can Floom connect to/i })).toBeInTheDocument();
    // The old false "Emily builds it" create pills are gone.
    expect(screen.queryByRole("button", { name: /Create a Linear triage worker/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Show me this week's runs/i })).not.toBeInTheDocument();
  });

  it("renders the real PromptInput composer, centered, with the generic placeholder", async () => {
    render(<EmilyChatCore fullPage createMode />);
    const composers = await screen.findAllByPlaceholderText("Message Emily...");
    // Exactly one composer (centered in the empty state, no bottom clone).
    expect(composers).toHaveLength(1);
    expect(composers[0].tagName).toBe("TEXTAREA");
    // #1706: the landing send CTA is now aria-label="Hire worker" (canonical action name).
    // Assert the bespoke hero HEADING is absent, not the action button.
    expect(screen.queryByRole("heading", { name: /hire a new worker/i })).not.toBeInTheDocument();
  });

  it("clicking a helper pill primes the composer with that prompt", async () => {
    const user = userEvent.setup();
    render(<EmilyChatCore fullPage createMode />);
    const composer = (await screen.findByPlaceholderText("Message Emily...")) as HTMLTextAreaElement;
    expect(composer.value).toBe("");
    await user.click(screen.getByRole("button", { name: /Which template fits my team/i }));
    expect(composer.value).toBe("Which template fits my team?");
  });
});
