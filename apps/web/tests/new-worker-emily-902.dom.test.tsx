// #902 (punchlist A1) — "New worker" primes Emily full-screen instead of the
// removed /workers/new form page. Wireframe newWorker(): Emily full overlay.
//
// Federico 2026-06-19: the bespoke "Hire a new worker" hero is GONE. Create is
// now the SAME consistent Emily empty state as the home (greeting + pills +
// centered composer), driven by `/?create=1`. createMode stays a behavior flag
// only. The shared engine is EmilyChatCore (createMode); this pins the create
// surface to that consistency + verifies all create entry points still route to
// the home create flow.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

// EmilyHomeEmpty reads the overview/workers hooks — stub so it renders the
// active-workspace empty state without a QueryClient provider.
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

import { EmilyChatCore, EmilyChatPage } from "@/components/emily/EmilyChat";

const root = path.resolve(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf-8");

describe("#902 New worker → consistent Emily empty state", () => {
  it("create mode shows the consistent Emily composer (generic placeholder, centered)", async () => {
    render(<EmilyChatCore fullPage createMode />);
    const composers = await screen.findAllByPlaceholderText("Message Emily...");
    expect(composers).toHaveLength(1);
  });

  it("create mode does NOT render the bespoke hero or ADD SOURCES row", async () => {
    render(<EmilyChatCore fullPage createMode />);
    await screen.findByText(/done this week/i);
    expect(screen.queryByRole("heading", { name: "Hire a new worker" })).not.toBeInTheDocument();
    expect(screen.queryByText(/Add sources/i)).not.toBeInTheDocument();
  });

  it("default mode keeps the normal placeholder", () => {
    render(<EmilyChatPage />);
    expect(screen.getByPlaceholderText("Message Emily...")).toBeInTheDocument();
  });

  it("primeInput pre-fills the composer (legacy ?prompt= deep links)", async () => {
    render(<EmilyChatCore fullPage createMode primeInput="Create me: a digest worker" />);
    expect(
      await screen.findByDisplayValue("Create me: a digest worker"),
    ).toBeInTheDocument();
  });

  it("sidebar has the Hire worker button routing to the home create flow", () => {
    const sidebar = src("components/layout/sidebar.tsx");
    expect(sidebar).toContain('href="/?create=1"');
    expect(sidebar).toContain("Hire worker"); /* #1706: canonical "Hire worker" */
  });

  it("/workers/new is a redirect, not a form; all create entry points use the home create flow", () => {
    const newPage = src("app/workers/new/page.tsx");
    expect(newPage).toContain("redirect(`/?create=1");
    expect(newPage).not.toContain("worker-author");
    expect(src("app/workers/WorkersCollection.tsx")).toContain('router.push("/?create=1")');
    expect(src("components/CommandPalette.tsx")).toContain('go("/?create=1")');
    // The legacy /chat?mode=create deep link still works → redirects to the home
    // create flow instead of rendering a separate full-page create surface.
    expect(src("app/chat/page.tsx")).toContain("redirect(`/?create=1");
  });
});
