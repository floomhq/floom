import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// #1183: the run-detail Output tab used to show only a file-download stub
// (title + filename + download icon) for small text/markdown artifacts,
// forcing users to download the file or scroll the infra-log feed to read
// output. These tests prove OutputFileLink now fetches + renders small
// markdown/text artifacts inline (via the existing sanitized GenericOutput
// renderer), while still keeping the download link, and while still leaving
// large/binary artifacts as download-only stubs.

const { downloadUrl, artifactUrl, bundleUrl, artifactText } = vi.hoisted(() => ({
  downloadUrl: vi.fn((id: string) => `/api/runs/${id}/download`),
  artifactUrl: vi.fn((id: string, artifactId: string) => `/api/runs/${id}/artifacts/${artifactId}`),
  bundleUrl: vi.fn((id: string, path: string) => `/api/runs/${id}/bundle/${path}`),
  artifactText: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    runs: {
      downloadUrl,
      artifactUrl,
      bundleUrl,
      artifactText,
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
    id: "run_1183_inline",
    worker_id: "worker-1183",
    worker_name: "worker-1183",
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

describe("#1183 inline artifact preview in the Output tab", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders a small markdown artifact's content inline, not just a download stub", async () => {
    artifactText.mockResolvedValueOnce("# Report\n\nThe run produced **3** findings.");

    render(
      <RunDetailSplitPane
        inline
        run={run({
          output_schema: [
            { name: "report", kind: "file", label: "Report", type: "markdown", value: "out/report.md" },
          ],
          artifacts: [
            {
              id: "artifact-report",
              run_id: "run_1183_inline",
              name: "report.md",
              path: "out/report.md",
              relative_path: "out/report.md",
              type: "text/markdown",
              size_bytes: 512,
              created_at: "2026-06-26T22:56:54Z",
            },
          ],
        })}
      />,
    );

    // The download stub is still present (kept alongside the inline render).
    expect(screen.getByRole("link", { name: /Report out\/report\.md/i })).toHaveAttribute(
      "href",
      "/api/runs/run_1183_inline/artifacts/artifact-report",
    );

    // Before the fix, this is where the buried-output bug lived: the artifact
    // body was never fetched, so the finding text below never appeared
    // anywhere in the Output tab (only in the raw infra-log feed).
    expect(artifactText).toHaveBeenCalledWith("run_1183_inline", "artifact-report");
    await waitFor(() => {
      expect(screen.getByText(/The run produced/i)).toBeInTheDocument();
    });
    expect(screen.getByText("3")).toBeInTheDocument();
  });

  it("does not fetch or inline an artifact larger than the 256KB cap", async () => {
    render(
      <RunDetailSplitPane
        inline
        run={run({
          output_schema: [
            { name: "report", kind: "file", label: "Report", type: "markdown", value: "out/report.md" },
          ],
          artifacts: [
            {
              id: "artifact-report-big",
              run_id: "run_1183_inline",
              name: "report.md",
              path: "out/report.md",
              relative_path: "out/report.md",
              type: "text/markdown",
              size_bytes: 300_000,
              created_at: "2026-06-26T22:56:54Z",
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("link", { name: /Report out\/report\.md/i })).toBeInTheDocument();
    expect(artifactText).not.toHaveBeenCalled();
  });

  it("does not inline a binary artifact (e.g. a zip bundle)", async () => {
    render(
      <RunDetailSplitPane
        inline
        run={run({
          output_schema: [
            { name: "bundle", kind: "file", label: "Bundle", type: "json", value: "out/bundle.zip" },
          ],
          artifacts: [
            {
              id: "artifact-zip",
              run_id: "run_1183_inline",
              name: "bundle.zip",
              path: "out/bundle.zip",
              relative_path: "out/bundle.zip",
              type: "application/zip",
              size_bytes: 1024,
              created_at: "2026-06-26T22:56:54Z",
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("link", { name: /Bundle out\/bundle\.zip/i })).toBeInTheDocument();
    expect(artifactText).not.toHaveBeenCalled();
  });
});
