"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Check, X, ArrowRight, Edit2 } from "lucide-react";
import type { ApprovalDetail } from "@/lib/types";
import { OutputRenderer } from "@/components/output-renderer";

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalDetail[]>([]);
  const [loading, setLoading] = useState(true);
  const [rejectModal, setRejectModal] = useState<{ runId: string; reason: string } | null>(null);
  const [editModal, setEditModal] = useState<{ runId: string; content: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(async () => {
    try {
      const a = await api.approvals.list("pending");
      setApprovals(a);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function approve(runId: string, editedOutput?: string) {
    setSubmitting(true);
    try {
      await api.runs.approve(runId, editedOutput);
      toast.success("Approved");
      setEditModal(null);
      void load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to approve");
    } finally {
      setSubmitting(false);
    }
  }

  async function rejectWithReason(runId: string, reason: string) {
    setSubmitting(true);
    try {
      await api.runs.reject(runId, reason.trim() || "Rejected by operator");
      toast.success("Rejected");
      setRejectModal(null);
      void load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to reject");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-[#666] text-sm mt-1">Review worker outputs before they complete.</p>
      </div>

      {/* Reject reason modal */}
      {rejectModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-md space-y-4">
            <h2 className="text-base font-semibold">Reject run</h2>
            <div className="space-y-1.5">
              <Label className="text-sm">Reason (optional, max 280 chars)</Label>
              <Textarea
                value={rejectModal.reason}
                onChange={(e) =>
                  setRejectModal((m) => m ? { ...m, reason: e.target.value.slice(0, 280) } : m)
                }
                placeholder="e.g. Output contains hallucinated company facts, needs manual review"
                className="min-h-[80px] border-[#e4e4e7]"
              />
              <p className="text-xs text-[#999] text-right">{rejectModal.reason.length}/280</p>
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setRejectModal(null)}>
                Cancel
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={submitting}
                onClick={() => rejectWithReason(rejectModal.runId, rejectModal.reason)}
                className="border-red-200 text-red-700 hover:bg-red-50"
              >
                <X className="w-4 h-4 mr-1" />
                {submitting ? "Rejecting..." : "Confirm reject"}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Edit-before-approve modal */}
      {editModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-xl p-6 w-full max-w-2xl space-y-4">
            <h2 className="text-base font-semibold">Edit output before approving</h2>
            <Textarea
              value={editModal.content}
              onChange={(e) => setEditModal((m) => m ? { ...m, content: e.target.value } : m)}
              className="min-h-[300px] border-[#e4e4e7] font-mono text-sm"
            />
            <div className="flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditModal(null)}>
                Cancel
              </Button>
              <Button
                variant="default"
                size="sm"
                disabled={submitting}
                onClick={() => approve(editModal.runId, editModal.content)}
                className="bg-emerald-600 hover:bg-emerald-700"
              >
                <Check className="w-4 h-4 mr-1" />
                {submitting ? "Approving..." : "Approve with edits"}
              </Button>
            </div>
          </div>
        </div>
      )}

      <div className="space-y-4">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-48 w-full" />)
        ) : approvals.length === 0 ? (
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardContent className="p-8 text-center space-y-2">
              <p className="text-sm font-medium text-[#666]">No pending approvals.</p>
              <p className="text-xs text-[#999]">Runs that require human sign-off will appear here when they finish.</p>
            </CardContent>
          </Card>
        ) : (
          approvals.map((a) => (
            <Card key={a.id} className="border-[#eaeaea] shadow-none bg-white">
              <CardContent className="p-5 space-y-4">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-medium">{a.worker_name || a.worker_id}</p>
                    <p className="text-xs text-[#999] mt-0.5">{a.label}</p>
                  </div>
                  <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50">
                    Pending
                  </Badge>
                </div>

                {a.preview && (
                  <div className="max-h-64 overflow-auto rounded-md border border-[#eaeaea] bg-white p-3">
                    {a.preview_type && a.preview_type !== "text" && a.preview_type !== "file" ? (
                      <OutputRenderer
                        field={{
                          name: "",
                          label: "",
                          type: a.preview_type,
                          value: a.preview,
                        }}
                      />
                    ) : (
                      <div className="text-sm whitespace-pre-wrap font-mono leading-relaxed">
                        {a.preview}
                      </div>
                    )}
                  </div>
                )}

                {a.decided_at && (
                  <p className="text-xs text-[#999]">
                    Decided {new Date(a.decided_at).toLocaleString()}
                    {a.reason ? ` — ${a.reason}` : ""}
                  </p>
                )}

                <div className="flex items-center justify-between">
                  <Link href={`/runs/${a.run_id}`} className="text-sm text-[#666] hover:text-[#111] flex items-center gap-1">
                    View run <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setRejectModal({ runId: a.run_id, reason: "" })}
                      className="border-red-200 text-red-700 hover:bg-red-50"
                    >
                      <X className="w-4 h-4 mr-1" />
                      Reject
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditModal({ runId: a.run_id, content: a.preview || "" })}
                      className="border-[#e4e4e7]"
                    >
                      <Edit2 className="w-4 h-4 mr-1" />
                      Edit
                    </Button>
                    <Button
                      variant="default"
                      size="sm"
                      onClick={() => approve(a.run_id)}
                      className="bg-emerald-600 hover:bg-emerald-700"
                    >
                      <Check className="w-4 h-4 mr-1" />
                      Approve
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>
    </div>
  );
}
