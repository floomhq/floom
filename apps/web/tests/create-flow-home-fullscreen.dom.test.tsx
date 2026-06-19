// CREATE = the SAME fullscreen Emily as the home, primed for create (Federico
// 2026-06-19: "/app/chat?mode=create is still not simply emily on full screen").
// "New worker" / the legacy /chat?mode=create now land on `/?create=1`, which the
// EmilyDock reads to:
//   1. force Emily into TRUE fullscreen on the home route (same surface as home),
//   2. render the create empty state (the "Hire a new worker" hero + create pills)
//      INSTEAD of the home pulse — one Emily surface, no separate /chat chrome,
//   3. seed the composer from `&prime=<text>` (the landing→app from-prompt handoff
//      and the workers empty-state prompt) once it arrives post-mount.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { search } = vi.hoisted(() => ({ search: vi.fn(() => "") }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(search()),
}));

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

// The plain-home assertion renders EmilyHomeEmpty (the home pulse), which reads
// these query hooks — stub them so it renders without a QueryClient provider.
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
      contexts: { list: vi.fn().mockResolvedValue([]) },
      chat: { uploadAttachments: vi.fn().mockResolvedValue([]) },
      conversations: { list: vi.fn().mockResolvedValue([]) },
      system: { overview: vi.fn().mockResolvedValue({ stats: { active_workers_count: 1 } }) },
      workspace: { getSettings: vi.fn().mockResolvedValue({}) },
    },
  };
});

import { EmilyDock } from "@/components/emily/EmilyChat";
import { EmilyFullscreenProvider } from "@/components/emily/emily-fullscreen";

const renderDock = () =>
  render(
    <EmilyFullscreenProvider>
      <EmilyDock />
    </EmilyFullscreenProvider>,
  );

describe("create flow = the home fullscreen Emily, primed for create", () => {
  beforeEach(() => {
    search.mockReturnValue("");
    sendMessage.mockClear();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
  });

  it("?create=1 on the home route enters TRUE fullscreen (same surface as home)", async () => {
    search.mockReturnValue("create=1");
    renderDock();
    expect(await screen.findByLabelText(/emily dock \(fullscreen\)/i)).toBeInTheDocument();
  });

  it("?create=1 renders the create hero (create placeholder + pills), NOT the home pulse", async () => {
    search.mockReturnValue("create=1");
    renderDock();
    // The create-primed composer placeholder (the create empty state), inside the
    // same one Emily core — no separate /chat 'Hire a worker' page chrome.
    expect(await screen.findByPlaceholderText("Create me: a worker that…")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Hire a new worker" })).toBeInTheDocument();
    // The home pulse must NOT show in create mode (create takes precedence).
    expect(screen.queryByText(/done this week/i)).not.toBeInTheDocument();
  });

  it("?prime=<text> seeds the create composer", async () => {
    search.mockReturnValue("create=1&prime=" + encodeURIComponent("Send me a GitHub PR digest at 9am"));
    renderDock();
    const composer = (await screen.findByPlaceholderText(
      "Create me: a worker that…",
    )) as HTMLTextAreaElement;
    expect(composer.value).toBe("Send me a GitHub PR digest at 9am");
  });

  it("plain home (no ?create=1) shows the home empty state, not the create hero", async () => {
    search.mockReturnValue("");
    renderDock();
    // Home → Emily fullscreen with the normal 'Message Emily' composer; the create
    // hero heading must be absent.
    expect(await screen.findByPlaceholderText(/Message Emily/i)).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Hire a new worker" })).not.toBeInTheDocument();
  });
});
