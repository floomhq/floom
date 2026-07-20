import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const { downloadUrl, artifactUrl, bundleUrl } = vi.hoisted(() => ({
  downloadUrl: vi.fn((id: string) => `/api/runs/${id}/download`),
  artifactUrl: vi.fn((id: string, artifactId: string) => `/api/runs/${id}/artifacts/${artifactId}`),
  bundleUrl: vi.fn((id: string, path: string) => `/api/runs/${id}/bundle/${path}`),
}));

vi.mock("@/lib/api", () => ({
  api: {
    runs: {
      downloadUrl,
      artifactUrl,
      bundleUrl,
      feedback: { list: vi.fn(), create: vi.fn() },
      createFeedbackIssue: vi.fn(),
    },
  },
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { RunDetailSplitPane } from "@/components/RunDetailSplitPane";
import type { RunDetail } from "@/lib/types";

function run(overrides: Partial<RunDetail> = {}): RunDetail {
  return {
    id: "run_dry_1230",
    worker_id: "follow-up-drafter",
    worker_name: "Follow-up drafter",
    status: "completed",
    trigger_source: "manual",
    runner: "e2b",
    input: { dry_run: true },
    output: {},
    output_schema: [],
    logs: [],
    artifacts: [],
    transcript: [],
    dry_run: true,
    ...overrides,
  };
}

describe("dry-run visibility", () => {
  it("shows a loud notice in the run output when the API flags a dry run", () => {
    render(<RunDetailSplitPane inline run={run()} />);

    const notice = screen.getByRole("status", { name: "Dry run" });
    expect(notice).toHaveTextContent(
      "Dry run: no external actions taken, no drafts created.",
    );
  });

  it("does not show the notice for a normal run", () => {
    render(<RunDetailSplitPane inline run={run({ dry_run: false, input: {} })} />);

    expect(screen.queryByRole("status", { name: "Dry run" })).not.toBeInTheDocument();
  });
});
