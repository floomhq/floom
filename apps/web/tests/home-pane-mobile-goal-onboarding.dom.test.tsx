import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { workers } = vi.hoisted(() => ({ workers: { data: [] as unknown[] } }));

vi.mock("@/components/emily/emily-fullscreen", () => ({
  useEmilyFullscreen: () => ({ fullscreen: false }),
}));

vi.mock("@/lib/use-is-desktop", () => ({
  useIsDesktop: () => false,
}));

vi.mock("@/lib/query/hooks", () => ({
  qk: { overview: ["system", "overview"] },
  useStreamedInitialData: vi.fn(),
  useWorkers: () => ({ data: workers.data, isLoading: false, isError: false }),
}));

vi.mock("@/app/workers/WorkersCollection", () => ({
  default: () => <div>Workers collection</div>,
}));

vi.mock("@/components/home/GoalOnboarding", () => ({
  GoalOnboarding: () => <div>Goal onboarding surface</div>,
}));

import { HomePane } from "@/components/home/HomePane";

beforeEach(() => {
  workers.data = [];
});

describe("mobile first-open home", () => {
  it("shows goal onboarding immediately when the workspace has no real workers", () => {
    render(<HomePane />);
    expect(screen.getByText("Goal onboarding surface")).toBeInTheDocument();
    expect(screen.queryByText("Workers collection")).not.toBeInTheDocument();
  });

  it("keeps the workers collection for an active workspace", () => {
    workers.data = [{ id: "worker-1", archived: false, system: false, is_example: false }];
    render(<HomePane />);
    expect(screen.getByText("Workers collection")).toBeInTheDocument();
    expect(screen.queryByText("Goal onboarding surface")).not.toBeInTheDocument();
  });
});
