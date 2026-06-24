import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { StandaloneShareCard } from "@/app/s/[token]/StandaloneShareCard";
import type React from "react";
import type { ApprovalRow, StandaloneShare } from "@/lib/types";

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

function approval(index: number, preview: string): ApprovalRow & { kind: string } {
  return {
    id: `apr_${index}`,
    run_id: `run_${index}`,
    worker_id: "content-pub-cp",
    status: "pending",
    label: "Approve social posts before they enter the Buffer queue(s)",
    preview,
    created_at: "2026-06-23T22:36:08.062297+00:00",
    artifacts: [],
    preview_payload: null,
    kind: "run",
  };
}

describe("StandaloneShareCard approvals_batch", () => {
  it("renders a batch payload without top-level files and starts on inline media", () => {
    const approvals = [
      approval(1, '{ "phase": "config", "error": "first item has no media" }'),
      ...Array.from({ length: 12 }, (_, i) =>
        approval(i + 2, `Video: https://buildingopen.org/share/sf/review/SHORT_${i + 1}.mp4`),
      ),
    ];
    const share = {
      entity_type: "approvals_batch",
      title: "Pending approvals",
      description: "Actionable public link for this workspace's pending approvals.",
      approvals,
    } as StandaloneShare;

    const { container } = render(
      <StandaloneShareCard share={share} token="fls_test" authed={false} />,
    );

    expect(screen.getByText("13 pending")).toBeTruthy();
    expect(screen.getByText(/Approval 2/)).toBeTruthy();
    expect(screen.getByText(/of 13/)).toBeTruthy();

    const video = container.querySelector('[data-testid="preview-media-video"] video');
    expect(video).toBeTruthy();
    expect(video?.getAttribute("src")).toBe(
      "https://buildingopen.org/share/sf/review/SHORT_1.mp4",
    );
    expect(container.innerHTML).not.toContain("action_token");
  });
});
