import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { WorkerShareCard } from "@/components/share/WorkerShareCard";
import type { PublicWorker } from "@/lib/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    workers: {
      importFromShare: vi.fn(),
    },
  },
}));

const worker: PublicWorker = {
  id: "w_linear_triage",
  name: "Linear Triage",
  description: "Prioritises Linear issues for review.",
  use_cases: ["Review stale bugs", "Summarise escalations", "Assign urgent tickets"],
  how_it_works: "Reads Linear issues and prepares a ranked triage brief.",
  is_example: false,
  tags: [],
  example_input: null,
  example_output: "",
  trigger_type: "schedule",
  runtime: "skill",
  connections: ["linear"],
  inputs: [
    {
      name: "team",
      label: "Team",
      type: "string",
      required: true,
      description: null,
    },
  ],
  outputs: [
    {
      name: "brief",
      label: "Brief",
      type: "markdown",
    },
  ],
};

describe("WorkerShareCard setup view", () => {
  it("shows readable setup instead of a raw worker.yml tab", () => {
    const { container } = render(<WorkerShareCard worker={worker} authed={false} token="share_token" />);

    expect(screen.queryByRole("button", { name: "worker.yml" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Setup" }));

    expect(screen.getByText("Trigger")).toBeInTheDocument();
    expect(screen.getAllByText("Runs on a schedule").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Tools")).toBeInTheDocument();
    expect(screen.getAllByText("linear").length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('use[href="#brand-linear"]')).toBeTruthy();
    expect(screen.getByText("Inputs")).toBeInTheDocument();
    expect(screen.getByText("Team")).toBeInTheDocument();
    expect(screen.getByText("string · Required")).toBeInTheDocument();
    expect(screen.getByText("Outputs")).toBeInTheDocument();
    expect(screen.getByText("Brief")).toBeInTheDocument();
    expect(screen.getByText("markdown")).toBeInTheDocument();
  });
});
