import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ApprovalReviewBody } from "@/components/share/ApprovalReviewBody";
import { findPreviewMedia } from "@/components/share/PreviewMedia";
import type { ApprovalRow } from "@/lib/types";

// #1739: the approval / review "Proposed output" rendered a worker's media URL
// as bare text, so a reviewer had to copy it into a new tab to actually watch
// the video. The preview now embeds an inline <video>/<img> for safe http(s)
// media URLs IN ADDITION to the text, on both the in-app body and the public
// /review surface (both reuse ApprovalReviewBody).

function baseRow(extra: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    id: "apr_1",
    run_id: "run_1",
    worker_id: "video-renderer",
    worker_name: "video-renderer",
    status: "pending",
    label: "Approve the rendered video",
    created_at: new Date().toISOString(),
    ...extra,
  };
}

function renderBody(approval: ApprovalRow) {
  return render(
    <ApprovalReviewBody
      approval={approval}
      actionLine="Approve the rendered video"
      index={0}
      total={1}
      onPrev={() => {}}
      onNext={() => {}}
      comment=""
      onComment={() => {}}
      approveKeepsComment={false}
      busy={false}
      onApprove={() => {}}
      onReject={() => {}}
    />,
  );
}

describe("#1739 inline preview media", () => {
  it("embeds an inline <video> when the preview text contains a video URL", () => {
    renderBody(
      baseRow({
        preview: "Rendered the explainer: https://cdn.example.com/render/final.mp4",
        decision_input_json: "{}",
      }),
    );
    const block = screen.getByTestId("preview-media-video");
    const video = block.querySelector("video");
    expect(video).toBeTruthy();
    expect(video?.getAttribute("src")).toBe("https://cdn.example.com/render/final.mp4");
    expect(video?.hasAttribute("controls")).toBe(true);
    expect(video?.hasAttribute("playsinline")).toBe(true);
    expect(video?.hasAttribute("autoplay")).toBe(false);
    // The original text stays visible alongside the embed.
    expect(screen.getByText(/Rendered the explainer:/)).toBeTruthy();
  });

  it("embeds an inline <img> when the preview text contains an image URL", () => {
    renderBody(
      baseRow({
        preview: "Screenshot attached: https://cdn.example.com/shots/page.png",
        decision_input_json: "{}",
      }),
    );
    const block = screen.getByTestId("preview-media-image");
    const img = block.querySelector("img");
    expect(img).toBeTruthy();
    expect(img?.getAttribute("src")).toBe("https://cdn.example.com/shots/page.png");
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
  });

  it("does not embed anything for a plain text preview without a media URL", () => {
    renderBody(baseRow({ preview: "Send the draft email to the prospect.", decision_input_json: "{}" }));
    expect(screen.queryByTestId("preview-media-video")).toBeNull();
    expect(screen.queryByTestId("preview-media-image")).toBeNull();
    expect(screen.getByText("Send the draft email to the prospect.")).toBeTruthy();
  });
});

describe("#1739 findPreviewMedia", () => {
  it("detects video extensions (.mp4/.mov/.webm/.m4v)", () => {
    for (const ext of ["mp4", "mov", "webm", "m4v"]) {
      expect(findPreviewMedia(`https://h/v.${ext}`)).toEqual({ url: `https://h/v.${ext}`, kind: "video" });
    }
  });

  it("detects image extensions (.png/.jpg/.jpeg/.gif/.webp)", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp"]) {
      expect(findPreviewMedia(`https://h/i.${ext}`)).toEqual({ url: `https://h/i.${ext}`, kind: "image" });
    }
  });

  it("matches a URL with a query string and ignores trailing punctuation", () => {
    expect(findPreviewMedia("see https://h/v.mp4?token=abc.")).toEqual({
      url: "https://h/v.mp4?token=abc",
      kind: "video",
    });
  });

  it("rejects unsafe and non-media URLs", () => {
    expect(findPreviewMedia("javascript:alert(1)//x.mp4")).toBeNull();
    expect(findPreviewMedia("file:///etc/passwd.png")).toBeNull();
    expect(findPreviewMedia("https://h/page.html")).toBeNull();
    expect(findPreviewMedia(null)).toBeNull();
    expect(findPreviewMedia("")).toBeNull();
  });
});
