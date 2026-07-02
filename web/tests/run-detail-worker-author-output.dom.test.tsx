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
    id: "run_worker_author_1",
    worker_id: "worker-author",
    worker_name: "worker-author",
    status: "completed",
    trigger_source: "manual",
    runner: "e2b",
    input: {},
    output: {},
    output_schema: [],
    logs: [],
    artifacts: [],
    transcript: [],
    created_at: "2026-06-26T22:56:54Z",
    duration_ms: 47500,
    ...overrides,
  };
}

describe("RunDetailSplitPane worker-author output", () => {
  it("renders a readable worker-author fallback when an old run only has bundle output", () => {
    render(
      <RunDetailSplitPane
        inline
        run={run({
          output_schema: [
            { name: "bundle", kind: "file", label: "Worker bundle", type: "json", value: "out/bundle.json" },
          ],
          artifacts: [
            {
              id: "artifact-bundle",
              run_id: "run_worker_author_1",
              name: "bundle.json",
              path: "out/bundle.json",
              relative_path: "out/bundle.json",
              type: "application/json",
              created_at: "2026-06-26T22:56:54Z",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Worker draft")).toBeInTheDocument();
    expect(screen.getByText("Worker bundle generated")).toBeInTheDocument();
    expect(screen.getByText(/produced a draft bundle for review/i)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Worker bundle out\/bundle\.json/i })).toHaveAttribute(
      "href",
      "/api/runs/run_worker_author_1/artifacts/artifact-bundle",
    );
  });

  it("keeps markdown summary as the primary output and moves bundle to generated files", () => {
    render(
      <RunDetailSplitPane
        inline
        run={run({
          output: {
            summary: "## Gmail Intake Brief\n\nWorker id: `gmail-intake-brief`",
            bundle: "out/bundle.json",
          },
          output_schema: [
            { name: "summary", kind: "scalar", label: "Summary", type: "markdown", value: "## Gmail Intake Brief\n\nWorker id: `gmail-intake-brief`" },
            { name: "bundle", kind: "file", label: "Worker bundle", type: "json", value: "out/bundle.json" },
          ],
          artifacts: [
            {
              id: "artifact-bundle",
              run_id: "run_worker_author_1",
              name: "bundle.json",
              path: "out/bundle.json",
              relative_path: "out/bundle.json",
              type: "application/json",
              created_at: "2026-06-26T22:56:54Z",
            },
          ],
        })}
      />,
    );

    expect(screen.getByText("Gmail Intake Brief")).toBeInTheDocument();
    expect(screen.getByText("Generated files")).toBeInTheDocument();
    expect(screen.queryByText("Worker bundle generated")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Worker bundle out\/bundle\.json/i })).toHaveAttribute(
      "href",
      "/api/runs/run_worker_author_1/artifacts/artifact-bundle",
    );
  });
});
