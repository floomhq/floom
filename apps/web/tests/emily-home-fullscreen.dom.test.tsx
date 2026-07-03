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
      stats: {
        active_workers_count: 3,
        paused_workers_count: 1,
        connections_healthy: 2,
        connections_total: 3,
        work_shipped_7d: 7,
        running_now: 1,
        queued_now: 1,
        runs_today: 12,
        completed_today: 10,
        failed_today: 2,
        runs_24h: 12,
        runs_24h_sparkline: [2, 3, 1, 4, 2, 0, 1, 3, 5, 4, 3, 2, 1, 0, 2, 3, 4, 5, 3, 2, 1, 0, 2, 3],
        scheduled_24h_count: 0,
        runs_7d_sparkline: [
          { label: "Mon", started_at: "2026-06-27T00:00:00Z", total: 4, failed: 0 },
          { label: "Tue", started_at: "2026-06-28T00:00:00Z", total: 5, failed: 1 },
          { label: "Wed", started_at: "2026-06-29T00:00:00Z", total: 3, failed: 0 },
          { label: "Thu", started_at: "2026-06-30T00:00:00Z", total: 6, failed: 0 },
          { label: "Fri", started_at: "2026-07-01T00:00:00Z", total: 2, failed: 1 },
          { label: "Sat", started_at: "2026-07-02T00:00:00Z", total: 4, failed: 0 },
          { label: "Sun", started_at: "2026-07-03T00:00:00Z", total: 7, failed: 0 },
        ],
      },
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
    expect(screen.getAllByText(/need attention/i).length).toBeGreaterThan(0);
    // Stat card labels (new 4-card layout with real sparkline data).
    expect(screen.getByText("Runs completed")).toBeInTheDocument();
    expect(screen.getByText("last 7 days")).toBeInTheDocument();
    expect(screen.getByText("Runs today")).toBeInTheDocument();
    expect(screen.getByText("Workers active")).toBeInTheDocument();
    expect(screen.getByText("Coming up today")).toBeInTheDocument();
    // Values from the mocked overview stats.
    expect(screen.getAllByText("7").length).toBeGreaterThan(0); // completedThisWeek
    expect(screen.getByText("3")).toBeInTheDocument();          // active_workers_count
    expect(screen.getByText("1 paused")).toBeInTheDocument();   // paused_workers_count

    // Greeting is the primary heading — H1-scale, visually above the pulse line.
    const greeting = screen.getByText(/Good (morning|afternoon|evening)/i);
    expect(greeting.className).toContain("text-[21px]");
    expect(greeting.className).toContain("font-semibold");

    // SVG sparklines rendered for the two run-series cards (7d + 24h each have ≥2 points).
    // The Sparkline area variant renders an SVG with fill and a stroke path.
    const sparklineSvgs = document.querySelectorAll("svg");
    expect(sparklineSvgs.length).toBeGreaterThanOrEqual(2);

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
