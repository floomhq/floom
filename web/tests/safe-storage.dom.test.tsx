import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

import { safeStorageGet, safeStorageSet } from "@/lib/safe-storage";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("safe storage guards", () => {
  it("returns null/false when browser storage access throws", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });

    expect(safeStorageGet("local", "floom-theme")).toBeNull();
    expect(safeStorageSet("local", "floom-theme", "night")).toBe(false);

    if (original) Object.defineProperty(window, "localStorage", original);
  });

  it("theme controls render when localStorage is unavailable", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage disabled");
      },
    });
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });

    const { ThemeModeButton } = await import("@/components/ThemeModeButton");
    render(<ThemeModeButton />);

    expect(screen.getByRole("button", { name: /theme mode/i })).toBeInTheDocument();

    if (original) Object.defineProperty(window, "localStorage", original);
  });
});

describe("global error boundary telemetry", () => {
  it("reports non-chunk app errors instead of swallowing them", async () => {
    const reportError = vi.fn();
    const trackTelemetry = vi.fn();
    vi.doMock("@/lib/notify", () => ({ reportError }));
    vi.doMock("@/lib/telemetry", () => ({ trackTelemetry }));

    const { default: GlobalError } = await import("@/app/error");
    render(<GlobalError error={new Error("boom")} reset={vi.fn()} />);

    await waitFor(() => expect(reportError).toHaveBeenCalledWith("Unhandled app error.", expect.any(Error)));
    expect(trackTelemetry).toHaveBeenCalledWith(
      "web.unhandled_error",
      expect.objectContaining({ message: "boom" }),
    );
  });
});
