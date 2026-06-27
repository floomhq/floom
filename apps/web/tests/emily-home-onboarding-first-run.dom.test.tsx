// First-run / onboarding gates (#1698 + #1699).
//
// #1699 — zero-state home: a workspace with ZERO workers AND zero runs must see
//   the EmilyHomeEmpty first-worker hero ("Let's hire your first worker"), NOT
//   the populated greeting ("X done this week") that assumes data. A populated
//   workspace (>0 workers) keeps the normal home — the gate is workers-success
//   keyed (resolveWorkersGate), never tripped on error/loading.
//
// #1698 — "New worker" / ?create=1 is a reliable first action: entering create
//   mode focuses the composer (visible feedback, not a dead click) and never
//   fires the "Couldn't open that item" toast (create is not an item id).
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

const { pathname, search } = vi.hoisted(() => ({
  pathname: vi.fn(() => "/"),
  search: vi.fn(() => ""),
}));
const { toastError } = vi.hoisted(() => ({ toastError: vi.fn() }));

vi.mock("sonner", () => ({ toast: { error: toastError, success: vi.fn() } }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn(), refresh: vi.fn() }),
  usePathname: () => pathname(),
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

// Mutable workspace fixture: an empty workspace (0 workers, 0 runs) vs a
// populated one. The home gate reads useWorkers (real-worker count) + useOverview.
const { workspace } = vi.hoisted(() => ({ workspace: { workers: [] as unknown[] } }));
vi.mock("@/lib/query/hooks", () => ({
  useOverview: () => ({
    data: {
      stats: { work_shipped_7d: workspace.workers.length === 0 ? 0 : 116 },
      outcomes: [],
      recent_runs: [],
      scheduled_today: [],
      needs_attention: [],
    },
    isError: false,
    isLoading: false,
  }),
  useWorkers: () => ({ data: workspace.workers, isError: false, isLoading: false }),
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
      system: { overview: vi.fn().mockResolvedValue({ stats: { active_workers_count: 0 } }) },
      workspace: { getSettings: vi.fn().mockResolvedValue({}) },
    },
  };
});

import { EmilyChatCore } from "@/components/emily/EmilyChat";

beforeEach(() => {
  pathname.mockReturnValue("/");
  search.mockReturnValue("");
  workspace.workers = [];
  sendMessage.mockClear();
  toastError.mockClear();
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
});

describe("#1699 zero-state home gate", () => {
  it("renders the first-worker zero-state for an empty workspace (0 workers, 0 runs)", async () => {
    workspace.workers = [];
    render(<EmilyChatCore homeMode />);
    // The teaching zero-state, NOT the data-assuming populated greeting.
    expect(await screen.findByText(/hire your first worker/i)).toBeInTheDocument();
    expect(screen.queryByText(/done this week/i)).not.toBeInTheDocument();
  });

  it("renders the populated home for a workspace WITH workers (not ripped out)", async () => {
    workspace.workers = [{ id: "w1", archived: false, system: false, is_example: false }];
    render(<EmilyChatCore homeMode />);
    expect(await screen.findByText(/done this week/i)).toBeInTheDocument();
    expect(screen.queryByText(/hire your first worker/i)).not.toBeInTheDocument();
  });
});

describe("#1698 New worker / create is a reliable first action", () => {
  it("entering create mode focuses the composer (visible feedback, not a dead click)", async () => {
    render(<EmilyChatCore createMode />);
    const composer = (await screen.findByPlaceholderText(/Message Emily/i)) as HTMLTextAreaElement;
    // autoFocus lands the caret in the composer so the click is never a no-op.
    expect(document.activeElement).toBe(composer);
  });

  it("create mode never fires the 'Couldn't open that item' toast", async () => {
    render(<EmilyChatCore createMode />);
    await screen.findByPlaceholderText(/Message Emily/i);
    await new Promise((r) => setTimeout(r, 30));
    expect(toastError).not.toHaveBeenCalled();
  });
});
