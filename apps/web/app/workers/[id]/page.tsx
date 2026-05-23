"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import { ArrowLeft, Play, Box } from "lucide-react";
import type { WorkerDetail, WorkerInput } from "@/lib/types";
const API_BASE = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8011";

export default function WorkerDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const [worker, setWorker] = useState<WorkerDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [inputs, setInputs] = useState<Record<string, any>>({});
  const [running, setRunning] = useState(false);
  const [toggling, setToggling] = useState(false);

  useEffect(() => {
    api.workers.get(id as string).then((w) => {
      setWorker(w);
      const defaults: Record<string, any> = {};
      w.config.inputs.forEach((inp: WorkerInput) => {
        if (inp.default !== undefined) defaults[inp.name] = inp.default;
        else if (inp.type === "boolean") defaults[inp.name] = false;
      });
      setInputs(defaults);
      setLoading(false);
    });
  }, [id]);

  async function handlePauseToggle() {
    if (!worker) return;
    setToggling(true);
    try {
      const action = worker.paused ? "unpause" : "pause";
      await fetch(`${API_BASE}/workers/${worker.id}/${action}`, { method: "POST" });
      toast.success(worker.paused ? "Worker unpaused" : "Worker paused");
      const updated = await api.workers.get(worker.id);
      setWorker(updated);
    } catch (e: any) {
      toast.error(e.message || "Failed to toggle pause");
    } finally {
      setToggling(false);
    }
  }

  async function handleRun() {
    if (!worker) return;
    setRunning(true);
    try {
      const result = await api.workers.run(worker.id, inputs);
      toast.success("Run started");
      router.push(`/runs/${result.run_id}`);
    } catch (e: any) {
      toast.error(e.message || "Failed to start run");
    } finally {
      setRunning(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (!worker) {
    return <div className="text-sm text-[#999]">Worker not found.</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push("/workers")}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
            <Box className="w-5 h-5 text-[#999]" />
            {worker.name}
          </h1>
          <p className="text-[#666] text-sm">{worker.description}</p>
        </div>
        <div className="flex items-center gap-2">
          {worker.paused && (
            <Badge variant="outline" className="text-gray-500 border-gray-200 bg-gray-50">Paused</Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={handlePauseToggle}
            disabled={toggling}
            className={worker.paused ? "border-emerald-200 text-emerald-700 hover:bg-emerald-50" : "border-[#e4e4e7]"}
          >
            {toggling ? "..." : worker.paused ? "Unpause" : "Pause"}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-6">
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Run worker</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {worker.config.inputs.map((inp: WorkerInput) => (
                <div key={inp.name} className="space-y-1.5">
                  <Label className="text-sm">
                    {inp.label}
                    {inp.required && <span className="text-red-500 ml-0.5">*</span>}
                  </Label>
                  {inp.type === "textarea" ? (
                    <Textarea
                      placeholder={inp.placeholder}
                      value={inputs[inp.name] || ""}
                      onChange={(e) => setInputs((prev) => ({ ...prev, [inp.name]: e.target.value }))}
                      className="min-h-[100px] border-[#e4e4e7]"
                    />
                  ) : inp.type === "select" ? (
                    <Select
                      value={inputs[inp.name] || inp.default || ""}
                      onValueChange={(val) => setInputs((prev) => ({ ...prev, [inp.name]: val }))}
                    >
                      <SelectTrigger className="border-[#e4e4e7]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {(inp.options || []).map((opt) => (
                          <SelectItem key={opt} value={opt}>
                            {opt}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : inp.type === "boolean" ? (
                    <div className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        id={`inp-${inp.name}`}
                        checked={inputs[inp.name] === true || inputs[inp.name] === "true"}
                        onChange={(e) => setInputs((prev) => ({ ...prev, [inp.name]: e.target.checked }))}
                        className="w-4 h-4 rounded border-[#e4e4e7] accent-black cursor-pointer"
                      />
                      <label htmlFor={`inp-${inp.name}`} className="text-sm text-[#666] cursor-pointer select-none">
                        {inp.placeholder || inp.label}
                      </label>
                    </div>
                  ) : inp.type === "file" ? (
                    <div className="space-y-1">
                      <input
                        type="file"
                        id={`inp-${inp.name}`}
                        className="block w-full text-sm text-[#666] file:mr-3 file:py-1.5 file:px-3 file:rounded file:border file:border-[#e4e4e7] file:text-xs file:font-medium file:bg-white file:text-[#333] hover:file:bg-[#f4f4f5] cursor-pointer"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          const reader = new FileReader();
                          reader.onload = (ev) => {
                            const result = ev.target?.result;
                            if (typeof result === "string") {
                              setInputs((prev) => ({ ...prev, [inp.name]: result }));
                            }
                          };
                          reader.readAsDataURL(file);
                        }}
                      />
                      {inputs[inp.name] && (
                        <p className="text-xs text-[#999]">
                          File loaded ({Math.round((inputs[inp.name] as string).length / 1024)}KB as base64)
                        </p>
                      )}
                    </div>
                  ) : (
                    <Input
                      type={inp.type === "number" ? "number" : "text"}
                      placeholder={inp.placeholder}
                      value={inputs[inp.name] || ""}
                      onChange={(e) => setInputs((prev) => ({ ...prev, [inp.name]: e.target.value }))}
                      className="border-[#e4e4e7]"
                    />
                  )}
                </div>
              ))}
              <Button onClick={handleRun} disabled={running || worker.paused} className="w-full">
                <Play className="w-4 h-4 mr-1.5" />
                {running ? "Starting..." : worker.paused ? "Worker paused" : "Run worker"}
              </Button>
            </CardContent>
          </Card>

          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Recent runs</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {worker.recent_runs?.length === 0 ? (
                <p className="text-sm text-[#999]">No runs yet.</p>
              ) : (
                worker.recent_runs?.map((r) => (
                  <div key={r.id} className="flex items-center justify-between p-2 rounded-md hover:bg-[#f4f4f5]">
                    <div>
                      <p className="text-sm font-medium">{r.id}</p>
                      <p className="text-xs text-[#999]">{r.created_at ? new Date(r.created_at).toLocaleString() : "—"}</p>
                    </div>
                    <Badge variant="outline">{r.status}</Badge>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-6">
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Configuration</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="flex justify-between">
                <span className="text-[#666]">Trigger</span>
                <span className="font-medium">{worker.config.trigger.type}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#666]">Runtime</span>
                <span className="font-medium">{worker.config.runtime.type}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#666]">Runner</span>
                <span className="font-medium">{worker.config.runtime.runner}</span>
              </div>
              <Separator className="my-2" />
              <div>
                <span className="text-[#666]">Secrets</span>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {worker.config.secrets.length === 0 ? (
                    <span className="text-xs text-[#999]">None</span>
                  ) : (
                    worker.config.secrets.map((s) => (
                      <Badge key={s} variant="secondary" className="text-xs font-normal">
                        {s}
                      </Badge>
                    ))
                  )}
                </div>
              </div>
              <div>
                <span className="text-[#666]">Outputs</span>
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {worker.config.outputs.map((o) => (
                    <Badge key={o.name} variant="outline" className="text-xs font-normal">
                      {o.label}
                    </Badge>
                  ))}
                </div>
              </div>
              {worker.config.approvals.required && (
                <div className="flex justify-between">
                  <span className="text-[#666]">Approval</span>
                  <span className="font-medium text-amber-600">Required</span>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
