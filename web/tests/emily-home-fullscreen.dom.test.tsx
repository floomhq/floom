// HOME = the EXISTING Emily, FULLSCREEN, with the home "stuff" in its empty
// state (Federico 2026-06-19). This replaces the WRONG parallel-composer
// EmilyHome. Proves:
//   1. On the home route ("/"), the EmilyDock forces Emily into TRUE fullscreen
//      (dock aria-label switches to the fullscreen variant) — no separate
//      main-pane composer.
//   2. EmilyChatCore in homeMode renders the home pulse ("{done} done this week")
//      and pills in Emily's EMPTY state, above the ONE real Emily composer.
//   3. Clicking a home pill seeds THAT real composer (single composer, no clone).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { pathname } = vi.hoisted(() => ({ pathname: vi.fn(() => "/") }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname(),
  useSearchParams: () => new URLSearchParams(),
}));

// Empty conversation → the EMPTY state (home pulse/pills) renders.
const sendMessage = vi.fn();
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
      sendMessage,
      newSession: vi.fn(),
      loadConversation: vi.fn(),
    }),
  };
});

// Active workspace (>0 workers) → the Active pulse branch (greeting + "done this
// week"), 2 needs-attention items so the fix affordance + count show.
vi.mock("@/lib/query/hooks", () => ({
  useOverview: () => ({
    data: {
      stats: { work_shipped_7d: 7 },
      outcomes: [],
      recent_runs: [],
      scheduled_today: [],
      needs_attention: [
        { type: "failing", worker_id: "w1", worker_name: "Digest", message: "run failed", action_url: "" },
      ],
    },
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
      system: { overview: vi.fn().mockResolvedValue({ stats: { active_workers_count: 1 } }) },
      workspace: { getSettings: vi.fn().mockResolvedValue({}) },
    },
  };
});

import { EmilyChatCore, EmilyDock } from "@/components/emily/EmilyChat";
import { EmilyFullscreenProvider } from "@/components/emily/emily-fullscreen";

describe("HOME = existing Emily, fullscreen, stuff in empty state", () => {
  beforeEach(() => {
    pathname.mockReturnValue("/");
    sendMessage.mockClear();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  it("EmilyDock goes FULLSCREEN on the home route (no parallel pane)", async () => {
    render(
      <EmilyFullscreenProvider>
        <EmilyDock />
      </EmilyFullscreenProvider>,
    );
    // The dock force-enters fullscreen on mount of the home route — its
    // aria-label reflects the fullscreen state.
    expect(await screen.findByLabelText(/emily dock \(fullscreen\)/i)).toBeInTheDocument();
  });

  it("renders the home pulse + pills in Emily's EMPTY state, above the ONE real composer", async () => {
    render(<EmilyChatCore homeMode />);

    // Pulse: "{done} done this week" (degrades gracefully but here overview loaded).
    expect(await screen.findByText(/done this week/i)).toBeInTheDocument();
    // Needs-attention affordance from the single attention item.
    expect(screen.getByText(/need attention/i)).toBeInTheDocument();

    // Exactly ONE Emily composer (the real EmilyChatCore one) — no clone.
    const composers = screen.getAllByPlaceholderText(/Message Emily/i);
    expect(composers).toHaveLength(1);
  });

  it("clicking a home pill seeds the REAL Emily composer (single composer)", async () => {
    const user = userEvent.setup();
    render(<EmilyChatCore homeMode />);

    const pill = await screen.findByRole("button", { name: /What ran overnight/i });
    await user.click(pill);

    const composer = screen.getByPlaceholderText(/Message Emily/i) as HTMLTextAreaElement;
    expect(composer.value).toBe("What ran overnight?");
  });
});
