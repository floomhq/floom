import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/layout/sidebar", () => ({ FloomMark: () => null }));

describe("branded not-found page", () => {
  it("renders WorkerOS copy and recovery actions", async () => {
    const { default: NotFound } = await import("@/app/not-found");
    render(<NotFound />);

    expect(screen.getByRole("heading", { name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("WorkerOS")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Back to Overview/i })).toHaveAttribute("href", "/overview");
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/login");
  });
});
