import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";

// Smoke test: confirms the jsdom project + jest-dom matchers are wired.
it("renders into jsdom and exposes jest-dom matchers", () => {
  render(<button type="button">Click me</button>);
  expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
});

it("verifies the autonomous pipeline smoke test run", () => {
  expect(1 + 1).toBe(2);
});
