"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { Check, CheckCircle, FileText, ImageIcon, Lock, X } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ApprovalAnnotations, ApprovalRow } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { WorkerosMark } from "@/components/share/ShareCardShell";
import { ApprovalActionItems, approvalActionLine } from "@/components/share/ApprovalActionItems";
import { GenericOutput } from "@/components/generic-output";

const MAX_COMMENT_LENGTH = 8000;

function parseDecisionInput(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function inferPreviewType(preview: string): string {
  const trimmed = preview.trim();
  if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
    return "json";
  }
  if (/^#{1,3}\s|\n[-*]\s|\|.+\|/.test(trimmed)) return "markdown";
  return "text";
}

function formatRelative(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

type FeedbackAttachment = {
  id: string;
  file: File;
  previewUrl?: string;
  uploadedUrl?: string;
  uploading: boolean;
  error?: string;
};

function attachmentId(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2)}`;
}

function isImage(file: File): boolean {
  return file.type.startsWith("image/");
}

function FeedbackDropzone({
  approval,
  token,
  isSignedLink,
  comment,
  attachments,
  onCommentChange,
  onAttachmentsChange,
}: {
  approval: ApprovalRow | null;
  token: string | null;
  isSignedLink: boolean;
  comment: string;
  attachments: FeedbackAttachment[];
  onCommentChange: (value: string) => void;
  onAttachmentsChange: Dispatch<SetStateAction<FeedbackAttachment[]>>;
}) {
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const uploadImage = useCallback(
    async (attachment: FeedbackAttachment) => {
      if (!approval || !isImage(attachment.file)) return;
      try {
        const result =
          isSignedLink && token
            ? await api.approvals.uploadScreenshotPublic(approval.id, token, attachment.file, attachment.file.name)
            : await api.approvals.uploadScreenshot(approval.id, attachment.file, attachment.file.name);
        onAttachmentsChange((current) =>
          current.map((item) =>
            item.id === attachment.id
              ? { ...item, uploadedUrl: result.url, uploading: false }
              : item
          )
        );
      } catch (error) {
        onAttachmentsChange((current) =>
          current.map((item) =>
            item.id === attachment.id
              ? {
                  ...item,
                  uploading: false,
                  error: error instanceof Error ? error.message : "Upload failed",
                }
              : item
          )
        );
      }
    },
    [approval, isSignedLink, onAttachmentsChange, token]
  );

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const nextAttachments = Array.from(files).map((file) => ({
        id: attachmentId(file),
        file,
        previewUrl: isImage(file) ? URL.createObjectURL(file) : undefined,
        uploading: Boolean(isImage(file) && approval),
      }));
      onAttachmentsChange((current) => [...current, ...nextAttachments]);
      for (const attachment of nextAttachments) {
        if (isImage(attachment.file) && approval) {
          void uploadImage(attachment);
        }
      }
    },
    [approval, onAttachmentsChange, uploadImage]
  );

  const removeAttachment = useCallback(
    (id: string) => {
      const attachment = attachments.find((item) => item.id === id);
      if (attachment?.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      onAttachmentsChange((current) => current.filter((item) => item.id !== id));
    },
    [attachments, onAttachmentsChange]
  );

  const imageCount = attachments.filter((item) => isImage(item.file)).length;
  const fileCount = attachments.length - imageCount;
  const attachmentText =
    attachments.length === 0
      ? "Drag & drop images or files here"
      : [
          imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"} attached` : null,
          fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"} attached` : null,
          "drag another image or file here",
        ]
          .filter(Boolean)
          .join(" - ");

  return (
    <div>
      <div
        data-approval-feedback-dropzone
        onDragEnter={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (event.dataTransfer.files.length > 0) addFiles(event.dataTransfer.files);
        }}
        className={`flex items-end gap-2 rounded-[var(--radius-button)] border bg-[var(--bg-app)] px-2.5 py-1.5 transition-colors ${
          dragging ? "border-[var(--ink)]" : "border-dashed border-[var(--line-strong)]"
        }`}
      >
        <Textarea
          value={comment}
          onChange={(event) => onCommentChange(event.target.value.slice(0, MAX_COMMENT_LENGTH))}
          rows={1}
          placeholder="Add a comment or drop an image…"
          className="min-h-8 max-h-24 resize-y border-0 bg-transparent px-0 py-1 text-[13px] leading-5 shadow-none focus-visible:ring-0"
        />
        {attachments.slice(0, 2).map((attachment) => (
          <button
            key={attachment.id}
            type="button"
            aria-label={`Remove ${attachment.file.name}`}
            onClick={() => removeAttachment(attachment.id)}
            className="relative inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-[8px] border border-[var(--border-soft)] bg-[var(--bg-2)] text-[var(--ink-soft)]"
            title={`${attachment.file.name} - click to remove`}
          >
            {attachment.previewUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={attachment.previewUrl} alt="" className="size-full object-cover" />
            ) : (
              <FileText className="size-4" />
            )}
            {attachment.uploading && <span className="absolute inset-0 bg-[var(--bg-card)]/60" />}
          </button>
        ))}
        {attachments.length > 2 && (
          <span className="inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] border border-[var(--border-soft)] bg-[var(--bg-2)] text-xs text-[var(--ink-soft)]">
            +{attachments.length - 2}
          </span>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(event) => {
            if (event.currentTarget.files) addFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        <button
          type="button"
          title="Attach an image or file"
          aria-label="Attach an image or file"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-[var(--ink)]"
        >
          <ImageIcon className="size-4" />
        </button>
      </div>

      <p className="mt-1.5 text-[10.5px] leading-4 text-[var(--ink-faint)]">{attachmentText}</p>
    </div>
  );
}

function buildAnnotations(comment: string, attachments: FeedbackAttachment[]): ApprovalAnnotations | null {
  const uploadedImages = attachments
    .filter((attachment) => isImage(attachment.file) && attachment.uploadedUrl)
    .map((attachment) => ({
      url: attachment.uploadedUrl as string,
      caption: attachment.file.name,
      pins: [],
    }));
  const fileNames = attachments
    .filter((attachment) => !isImage(attachment.file))
    .map((attachment) => attachment.file.name);
  const commentText = [comment.trim(), fileNames.length ? `Attached files: ${fileNames.join(", ")}` : ""]
    .filter(Boolean)
    .join("\n");

  if (!commentText && uploadedImages.length === 0) return null;
  return {
    text: commentText ? [{ quote: "", comment: commentText }] : [],
    images: uploadedImages,
  };
}

export function ApprovalReviewClient({
  targetId,
  token,
}: {
  targetId: string | null;
  token: string | null;
}) {
  const isSignedLink = Boolean(targetId && token);
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [comment, setComment] = useState("");
  const [attachments, setAttachments] = useState<FeedbackAttachment[]>([]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (targetId && token) {
        const approval = await api.approvals.publicGet(targetId, token);
        setRows([approval]);
        setIndex(0);
        return;
      }
      const pending = await api.approvals.list("pending");
      const filtered = targetId
        ? pending.filter((row) => row.id === targetId || row.run_id === targetId)
        : pending;
      setRows(filtered);
      setIndex(0);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load approvals");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [targetId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const approval = rows[index] ?? null;
  const decisionInput = useMemo(
    () => parseDecisionInput(approval?.decision_input_json),
    [approval?.decision_input_json]
  );
  const isDestructiveDelete = decisionInput.kind === "destructive_delete";
  const hasUploadingAttachment = attachments.some((attachment) => attachment.uploading);
  const failedUploads = attachments.filter((attachment) => attachment.error);

  useEffect(() => {
    setComment("");
    setAttachments((current) => {
      for (const attachment of current) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      return [];
    });
  }, [approval?.id]);

  const removeCurrent = useCallback(() => {
    setRows((current) => {
      const next = current.filter((row) => row.id !== approval?.id);
      setIndex((currentIndex) => Math.min(currentIndex, Math.max(0, next.length - 1)));
      return next;
    });
  }, [approval?.id]);

  const decide = useCallback(
    async (decision: "approve" | "reject") => {
      if (!approval) return;
      if (hasUploadingAttachment) {
        toast.error("Wait for image uploads to finish.");
        return;
      }
      if (failedUploads.length > 0) {
        toast.error("Remove failed image uploads before deciding.");
        return;
      }

      const annotations = buildAnnotations(comment, attachments);
      setBusy(decision);
      try {
        if (decision === "approve") {
          if (isSignedLink && token) {
            await api.approvals.publicApprove(approval.id, token, undefined, annotations);
          } else if (isDestructiveDelete) {
            await api.approvals.approveAction(approval.id, annotations);
          } else {
            await api.runs.approve(approval.run_id, undefined, annotations);
          }
          toast.success("Approved");
        } else {
          const reason = comment.trim() || undefined;
          if (isSignedLink && token) {
            await api.approvals.publicReject(approval.id, token, reason, annotations);
          } else if (isDestructiveDelete) {
            await api.approvals.rejectAction(approval.id, reason, annotations);
          } else {
            await api.runs.reject(approval.run_id, reason, annotations);
          }
          toast.success("Rejected");
        }
        removeCurrent();
      } catch (error) {
        toast.error(error instanceof Error ? error.message : `${decision === "approve" ? "Approve" : "Reject"} failed`);
      } finally {
        setBusy(null);
      }
    },
    [
      approval,
      attachments,
      comment,
      failedUploads.length,
      hasUploadingAttachment,
      isDestructiveDelete,
      isSignedLink,
      removeCurrent,
      token,
    ]
  );

  return (
    <div className="flex min-h-screen w-full items-center justify-center overflow-hidden bg-[var(--bg-app)] p-5">
      <Card
        data-approval-card
        className="h-[620px] w-full max-w-[480px] gap-0 p-0 shadow-[var(--shadow-card)] hover:translate-y-0 hover:border-[var(--card-border)] hover:shadow-[var(--shadow-card)]"
      >
        <CardHeader className="flex shrink-0 flex-row items-center justify-between gap-3 border-b border-[var(--border-default)] px-[18px] py-3">
          <WorkerosMark size={22} label="Workeros - Approval request" />
          <span className="inline-flex shrink-0 items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--border-soft)] bg-[var(--bg-card)] px-2.5 py-1 text-[11px] leading-none text-[var(--ink-mute)]">
            <Lock className="size-3" />
            Shared link
          </span>
        </CardHeader>

        {loading ? (
          <CardContent className="flex flex-1 flex-col gap-4 px-[18px] py-4">
            <div className="h-5 w-3/4 animate-pulse rounded bg-[var(--bg-2)]" />
            <div className="h-28 animate-pulse rounded-[var(--radius-button)] bg-[var(--bg-2)]" />
            <div className="h-24 animate-pulse rounded-[var(--radius-button)] bg-[var(--bg-2)]" />
          </CardContent>
        ) : !approval ? (
          <CardContent className="flex flex-1 items-center justify-center px-6 text-center">
            <div>
              <CheckCircle className="mx-auto size-9 text-[var(--ink-faint)]" />
              <h1 className="mt-4 text-xl font-semibold text-[var(--ink)]">No pending approvals</h1>
              <p className="mt-2 text-sm leading-6 text-[var(--ink-soft)]">
                Everything currently waiting for a decision has been handled.
              </p>
            </div>
          </CardContent>
        ) : (
          <>
            <CardContent className="min-h-0 flex-1 overflow-hidden px-[18px] py-3.5">
              <div className="min-h-0 space-y-3">
                <div>
                  <p className="text-[16px] font-semibold leading-snug text-[var(--ink)]">
                    {approvalActionLine(approval.label, decisionInput)}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[12.5px] text-[var(--ink-soft)]">
                    <span>{approval.worker_name ?? approval.worker_id}</span>
                    <span>-</span>
                    <span>{formatRelative(approval.created_at)}</span>
                  </div>
                </div>

                {!isDestructiveDelete && (
                  <div>
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.04em] text-[var(--ink-mute)]">
                      Action items
                    </p>
                    <ApprovalActionItems decisionInput={decisionInput} />
                  </div>
                )}

                <div className="overflow-hidden rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--paper-2)]">
                  <div className="flex items-center justify-between border-b border-[var(--border-default)] px-3 py-2">
                    <p className="text-xs font-medium text-[var(--ink-soft)]">Proposed output</p>
                    {approval.preview && (
                      <span className="font-mono text-[10.5px] text-[var(--ink-mute)]">
                        {inferPreviewType(approval.preview)}
                      </span>
                    )}
                  </div>
                  <div className="max-h-[116px] overflow-hidden px-3 py-2.5">
                    {approval.preview ? (
                      <GenericOutput
                        type={inferPreviewType(approval.preview)}
                        value={approval.preview}
                        className="text-xs leading-relaxed"
                      />
                    ) : (
                      <p className="text-sm text-[var(--ink-soft)]">No output.</p>
                    )}
                  </div>
                </div>
              </div>
            </CardContent>

            <CardFooter className="flex shrink-0 flex-col items-stretch gap-2.5 border-t border-[var(--border-default)] bg-[var(--bg-card)] px-3.5 py-3">
              <FeedbackDropzone
                approval={approval}
                token={token}
                isSignedLink={isSignedLink}
                comment={comment}
                attachments={attachments}
                onCommentChange={setComment}
                onAttachmentsChange={setAttachments}
              />
              <div className="grid grid-cols-2 gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="lg"
                  disabled={Boolean(busy) || hasUploadingAttachment}
                  onClick={() => void decide("reject")}
                  className="h-[38px] text-[var(--ink-soft)] hover:border-[color-mix(in_srgb,var(--warning)_30%,var(--border-default))] hover:bg-[color-mix(in_srgb,var(--warning)_8%,var(--bg-card))] hover:text-[var(--warning)]"
                >
                  <X className="size-4" />
                  {busy === "reject" ? "Rejecting" : "Reject"}
                </Button>
                <Button
                  type="button"
                  size="lg"
                  disabled={Boolean(busy) || hasUploadingAttachment}
                  onClick={() => void decide("approve")}
                  className="h-[38px]"
                >
                  <Check className="size-4" />
                  {busy === "approve" ? "Approving" : "Approve"}
                </Button>
              </div>
            </CardFooter>
          </>
        )}
      </Card>
    </div>
  );
}
