import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeModeButton } from "@/components/ThemeModeButton";
import { ThemeModeToggleGroup } from "@/components/ThemeModeToggleGroup";
import { getActiveWorkspaceId, setActiveWorkspaceId } from "@/lib/api";
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "@/lib/safe-storage";

let originalLocalStorage: PropertyDescriptor | undefined;

function makeLocalStorageThrow() {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() {
      throw new Error("storage unavailable");
    },
  });
}

beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");
});

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(window, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(window, "localStorage");
  }
});

describe("safe storage", () => {
  it("turns unavailable localStorage into null/no-op instead of throwing", () => {
    makeLocalStorageThrow();

    expect(safeStorageGet("local", "anything")).toBeNull();
    expect(() => safeStorageSet("local", "anything", "value")).not.toThrow();
    expect(() => safeStorageRemove("local", "anything")).not.toThrow();
  });

  it("keeps active workspace helpers usable when localStorage is blocked", () => {
    makeLocalStorageThrow();

    expect(getActiveWorkspaceId()).toBe("local-default");
    expect(() => setActiveWorkspaceId("ws_test")).not.toThrow();
    expect(() => setActiveWorkspaceId(null)).not.toThrow();
  });

  it("renders theme controls when localStorage is blocked", () => {
    makeLocalStorageThrow();

    render(
      <>
        <ThemeModeButton />
        <ThemeModeToggleGroup />
      </>
    );

    const cycleButton = screen.getByRole("button", { name: /theme mode/i });
    expect(cycleButton).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "System" })).toBeInTheDocument();

    expect(() => fireEvent.click(cycleButton)).not.toThrow();
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Dark" }))).not.toThrow();
  });
});
