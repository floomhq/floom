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
    expect(artifactText).toHaveBeenCalledWith("run_1183_inline", "artifact-report", { maxBytes: 256 * 1024 });
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

  // Codex review findings (post-implementation hardening), all re-verified here:
  //  (B) the 256KB inline cap must not rely on artifact metadata alone --
  //      OutputFileLink must pass it through to api.runs.artifactText so the
  //      data layer can enforce it against the real response too.
  //  (C) "markdown" mime matching must be exact, not a loose substring, so an
  //      unrelated mime that merely contains "markdown" isn't misclassified.
  //  (A) untrusted markdown images must never auto-load -- see the dedicated
  //      generic-output hardening test alongside generic-output.tsx's own
  //      suite; this file re-asserts the OutputFileLink -> GenericOutput wiring
  //      surfaces artifact markdown through the sanitized renderer at all.

  it("passes the 256KB cap through to api.runs.artifactText (defense in depth against spoofed size_bytes)", async () => {
    artifactText.mockResolvedValueOnce("# Report\n\nOK");

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

    await waitFor(() => {
      expect(artifactText).toHaveBeenCalledWith("run_1183_inline", "artifact-report", {
        maxBytes: 256 * 1024,
      });
    });
  });

  it("does not inline an artifact whose mime merely contains the substring \"markdown\" (exact-match only)", async () => {
    render(
      <RunDetailSplitPane
        inline
        run={run({
          output_schema: [
            { name: "report", kind: "file", label: "Report", type: "json", value: "out/report.weird" },
          ],
          artifacts: [
            {
              id: "artifact-weird",
              run_id: "run_1183_inline",
              name: "report.weird",
              path: "out/report.weird",
              relative_path: "out/report.weird",
              // Contains "markdown" as a substring but is not an exact
              // text/markdown or text/x-markdown mime, and has no .md
              // extension -- must NOT be treated as inlinable markdown.
              type: "application/x-not-quite-markdown",
              size_bytes: 512,
              created_at: "2026-06-26T22:56:54Z",
            },
          ],
        })}
      />,
    );

    expect(screen.getByRole("link", { name: /Report out\/report\.weird/i })).toBeInTheDocument();
    expect(artifactText).not.toHaveBeenCalled();
  });

  it("does not refetch when the artifact object's identity changes but its id stays the same", async () => {
    artifactText.mockResolvedValueOnce("# Report\n\nOK");

    const baseArtifact = {
      id: "artifact-report",
      run_id: "run_1183_inline",
      name: "report.md",
      path: "out/report.md",
      relative_path: "out/report.md",
      type: "text/markdown",
      size_bytes: 512,
      created_at: "2026-06-26T22:56:54Z",
    };

    const { rerender } = render(
      <RunDetailSplitPane
        inline
        run={run({
          output_schema: [
            { name: "report", kind: "file", label: "Report", type: "markdown", value: "out/report.md" },
          ],
          artifacts: [{ ...baseArtifact }],
        })}
      />,
    );

    await waitFor(() => expect(artifactText).toHaveBeenCalledTimes(1));

    // Same id, new object identity (e.g. a parent re-render created a fresh
    // artifacts array) -- must not trigger a second fetch.
    rerender(
      <RunDetailSplitPane
        inline
        run={run({
          output_schema: [
            { name: "report", kind: "file", label: "Report", type: "markdown", value: "out/report.md" },
          ],
          artifacts: [{ ...baseArtifact }],
        })}
      />,
    );

    expect(artifactText).toHaveBeenCalledTimes(1);
  });
});
