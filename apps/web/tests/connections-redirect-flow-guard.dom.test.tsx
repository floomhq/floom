import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// P1 connection-flow audit (2026-06-23): the /connections/redirect page must
//  (a) render the PROPER provider display name ("Google Calendar", not the
//      naive "Googlecalendar") with the correct spacing in the explainer copy,
//  (b) NOT navigate the user back to the connect screen once they've left the
//      page (a stale in-flight poll tick used to call router.replace after
//      unmount), and
//  (c) surface a terminal "still waiting" state instead of spinning forever
//      when the connection never completes.

const openMock = vi.fn<typeof window.open>(() => ({}) as unknown as Window);
Object.defineProperty(window, "open", { value: openMock, writable: true });

const initiate = vi.fn();
const statusFn = vi.fn();
const listFn = vi.fn();
const replace = vi.fn();

vi.mock("next/navigation", () => ({
  useSearchParams: () =>
    new URLSearchParams("app=googlecalendar&return_to=%2Fconnections"),
  useRouter: () => ({ replace, push: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    connections: {
      initiate: (...args: unknown[]) => initiate(...args),
      status: (...args: unknown[]) => statusFn(...args),
      list: (...args: unknown[]) => listFn(...args),
    },
  },
}));

import RedirectPage from "@/app/connections/redirect/page";

const COMPOSIO_URL = "https://platform.composio.dev/link/abc123";

describe("connections/redirect provider name + flow guards", () => {
  beforeEach(() => {
    initiate.mockReset().mockResolvedValue({
      id: "floom-conn-1",
      app_name: "googlecalendar",
      redirect_url: COMPOSIO_URL,
    });
    statusFn.mockReset().mockResolvedValue({ status: "initiated" });
    listFn.mockReset().mockResolvedValue([]);
    replace.mockReset();
    openMock.mockReset().mockReturnValue({} as unknown as Window);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("humanizes the provider slug and keeps the space in the explainer copy", async () => {
    render(<RedirectPage />);
    // The explainer asserts BOTH the proper display name AND the spacing fix
    // ("Google Calendar on", never "Googlecalendaron").
    await waitFor(() =>
      expect(
        screen.getByText(/You authorize Google Calendar on Composio/i)
      ).toBeTruthy()
    );
    expect(screen.queryByText(/Googlecalendar/)).toBeNull();
  });

  it("does not navigate back to the connect screen after the user leaves", async () => {
    vi.useFakeTimers();
    const { unmount } = render(<RedirectPage />);
    // Flush initiate -> ready -> auto-open -> startPolling (first tick @2000ms).
    await vi.advanceTimersByTimeAsync(2100);
    expect(openMock).toHaveBeenCalled();

    // The user navigates away (e.g. clicks a worker): the page unmounts while
    // the connection later becomes active.
    unmount();
    listFn.mockResolvedValue([
      { id: "c1", app_name: "googlecalendar", status: "active" },
    ]);

    // Advance well past several poll intervals; the stale tick must not fire a
    // navigation now that the component is gone.
    await vi.advanceTimersByTimeAsync(15000);
    expect(replace).not.toHaveBeenCalled();
  });

  it("shows a terminal waiting state instead of spinning forever", async () => {
    vi.useFakeTimers();
    render(<RedirectPage />);
    // Drive past the 2-minute polling deadline; connection never goes active.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 5000);
    vi.useRealTimers();
    await waitFor(() =>
      expect(screen.getByText(/Still waiting for Google Calendar/i)).toBeTruthy()
    );
    expect(
      screen.getByRole("button", { name: /Check again/i })
    ).toBeTruthy();
  });
});
