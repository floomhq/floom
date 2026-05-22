"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { Check, X, ArrowRight } from "lucide-react";
import type { Approval } from "@/lib/types";

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<Approval[]>([]);
  const [loading, setLoading] = useState(true);

  async function load() {
    try {
      const a = await api.approvals.list("pending");
      setApprovals(a);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function approve(runId: string) {
    try {
      await api.runs.approve(runId);
      toast.success("Approved");
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  async function reject(runId: string) {
    try {
      await api.runs.reject(runId, "Rejected by user");
      toast.success("Rejected");
      load();
    } catch (e: any) {
      toast.error(e.message);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-[#666] text-sm mt-1">Review worker outputs before they complete.</p>
      </div>

      <div className="space-y-4">
        {loading ? (
          Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-48 w-full" />)
        ) : approvals.length === 0 ? (
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardContent className="p-8 text-center">
              <p className="text-sm text-[#999]">No pending approvals.</p>
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
                  <div className="bg-[#f4f4f5] p-3 rounded-md text-sm whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-auto">
                    {a.preview}
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <Link href={`/runs/${a.run_id}`} className="text-sm text-[#666] hover:text-[#111] flex items-center gap-1">
                    View run <ArrowRight className="w-3.5 h-3.5" />
                  </Link>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => reject(a.run_id)}
                      className="border-red-200 text-red-700 hover:bg-red-50"
                    >
                      <X className="w-4 h-4 mr-1" />
                      Reject
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
