// #902 (punchlist A1) — "New worker" primes Emily full-screen instead of the
// removed /workers/new form page. Wireframe newWorker(): Emily full overlay,
// composer placeholder "Create me: a worker that…".
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/chat",
  useSearchParams: () => new URLSearchParams(),
}));

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

import { EmilyChatPage } from "@/components/emily/EmilyChat";

const root = path.resolve(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(root, rel), "utf-8");

describe("#902 New worker → Emily full-screen", () => {
  it("create mode shows the create-primed composer placeholder", () => {
    render(<EmilyChatPage createMode />);
    expect(
      screen.getByPlaceholderText("Create me: a worker that…"),
    ).toBeInTheDocument();
  });

  it("default mode keeps the normal placeholder", () => {
    render(<EmilyChatPage />);
    expect(screen.getByPlaceholderText("Message Emily...")).toBeInTheDocument();
  });

  it("primeInput pre-fills the composer (legacy ?prompt= deep links)", () => {
    render(<EmilyChatPage createMode primeInput="Create me: a digest worker" />);
    expect(
      screen.getByDisplayValue("Create me: a digest worker"),
    ).toBeInTheDocument();
  });

  it("sidebar has the New worker button routing to the Emily create flow", () => {
    const sidebar = src("components/layout/sidebar.tsx");
    expect(sidebar).toContain('href="/chat?mode=create"');
    expect(sidebar).toContain("New worker");
  });

  it("/workers/new is a redirect, not a form; all create entry points use the chat flow", () => {
    const newPage = src("app/workers/new/page.tsx");
    expect(newPage).toContain("redirect(`/chat?mode=create");
    expect(newPage).not.toContain("worker-author");
    expect(src("app/workers/WorkersCollection.tsx")).toContain('router.push("/chat?mode=create")');
    expect(src("components/CommandPalette.tsx")).toContain('go("/chat?mode=create")');
  });
});
