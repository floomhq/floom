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
import { toast } from "sonner";
import { ArrowLeft, Save } from "lucide-react";
import type { ComposioTriggerItem, ConnectionItem, WorkerDetail } from "@/lib/types";

type TriggerType = "manual" | "schedule" | "webhook" | "composio";

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function triggerEventId(item: ComposioTriggerItem): string {
  return item.event || item.slug || item.id || item.name || "";
}

function triggerLabel(item: ComposioTriggerItem): string {
  return item.display_name || item.name || triggerEventId(item);
}

function triggerAppSlug(item?: ComposioTriggerItem): string {
  if (!item) return "";
  const loose = item as unknown as { toolkit_slug?: string; app_name?: string };
  return (item.toolkit?.slug || item.app?.slug || loose.toolkit_slug || loose.app_name || "").toLowerCase();
}

function buildTriggerYaml(
  triggerType: TriggerType,
  cronExpr: string,
  cronTimezone: string,
  composioEvent: string,
  composioConnectionId: string,
  composioFilters: string,
): string {
  const lines = [`trigger:`, `  type: ${triggerType}`];
  if (triggerType === "schedule") {
    lines.push(`  cron: ${yamlString(cronExpr || "0 9 * * MON")}`);
    lines.push(`  timezone: ${yamlString(cronTimezone || "Europe/Berlin")}`);
  }
  if (triggerType === "webhook") {
    lines.push(`  webhook:`);
    lines.push(`    secret: true`);
    lines.push(`    allowed_methods: [POST]`);
  }
  if (triggerType === "composio") {
    let filters: Record<string, unknown> = {};
    try {
      filters = composioFilters.trim() ? JSON.parse(composioFilters) : {};
    } catch {
      filters = {};
    }
    lines.push(`  composio:`);
    lines.push(`    event: ${yamlString(composioEvent)}`);
    lines.push(`    connection_id: ${yamlString(composioConnectionId)}`);
    lines.push(`    filters: ${JSON.stringify(filters)}`);
  }
  return lines.join("\n");
}

function replaceTriggerBlock(yaml: string, triggerYaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^trigger:\s*$/.test(line));
  if (start === -1) return `${yaml.trimEnd()}\n\n${triggerYaml}\n`;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z_][\w_-]*:\s*/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...triggerYaml.split("\n"), ...lines.slice(end)].join("\n");
}

export default function EditWorkerPage() {
  const { id } = useParams();
  const router = useRouter();
  const [worker, setWorker] = useState<WorkerDetail | null>(null);
  const [workerYml, setWorkerYml] = useState("");
  const [runPy, setRunPy] = useState("");
  const [saving, setSaving] = useState(false);
  const [triggerType, setTriggerType] = useState<TriggerType>("manual");
  const [cronExpr, setCronExpr] = useState("0 9 * * MON");
  const [cronTimezone, setCronTimezone] = useState("Europe/Berlin");
  const [composioTriggers, setComposioTriggers] = useState<ComposioTriggerItem[]>([]);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);
  const [triggerSearch, setTriggerSearch] = useState("");
  const [composioEvent, setComposioEvent] = useState("");
  const [composioConnectionId, setComposioConnectionId] = useState("");
  const [composioFilters, setComposioFilters] = useState("{}");

  useEffect(() => {
    Promise.all([
      api.workers.get(id as string),
      api.integrations.triggers().catch(() => ({ items: [] })),
      api.connections.list().catch(() => []),
    ]).then(([loadedWorker, triggerCatalog, connectionItems]) => {
      setWorker(loadedWorker);
      setWorkerYml(loadedWorker.manifest_yaml || "");
      setRunPy(loadedWorker.run_py || "");
      setTriggerType((loadedWorker.config.trigger.type as TriggerType) || "manual");
      setCronExpr(loadedWorker.config.trigger.cron || "0 9 * * MON");
      setCronTimezone(loadedWorker.config.trigger.timezone || "Europe/Berlin");
      setComposioEvent(loadedWorker.config.trigger.composio?.event || "");
      setComposioConnectionId(loadedWorker.config.trigger.composio?.connection_id || "");
      setComposioFilters(JSON.stringify(loadedWorker.config.trigger.composio?.filters || {}, null, 2));
      setComposioTriggers(triggerCatalog.items || []);
      setConnections(connectionItems);
    });
  }, [id]);

  const selectedComposioTrigger = composioTriggers.find((item) => triggerEventId(item) === composioEvent);
  const selectedAppSlug = triggerAppSlug(selectedComposioTrigger);
  const matchingConnections = connections.filter((connection) => {
    if (connection.status !== "active") return false;
    if (!selectedAppSlug) return true;
    return connection.app_name.toLowerCase() === selectedAppSlug;
  });
  const filteredComposioTriggers = composioTriggers
    .filter((item) => {
      const haystack = `${triggerEventId(item)} ${triggerLabel(item)} ${triggerAppSlug(item)}`.toLowerCase();
      return haystack.includes(triggerSearch.toLowerCase());
    })
    .slice(0, 100);

  async function save() {
    if (!worker) return;
    if (triggerType === "composio") {
      if (!composioEvent || !composioConnectionId) {
        toast.error("Connection event and ID are required");
        return;
      }
      try {
        JSON.parse(composioFilters || "{}");
      } catch {
        toast.error("Filters must be valid JSON");
        return;
      }
    }

    setSaving(true);
    try {
      const triggerYaml = buildTriggerYaml(
        triggerType,
        cronExpr,
        cronTimezone,
        composioEvent,
        composioConnectionId,
        composioFilters,
      );
      const updated = await api.workers.update(worker.id, replaceTriggerBlock(workerYml, triggerYaml), runPy);
      toast.success("Worker updated");
      router.push(`/workers/${updated.id}`);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to update worker");
    } finally {
      setSaving(false);
    }
  }

  if (!worker) {
    return <div className="text-sm text-[#999]">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={() => router.push(`/workers/${id}`)}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold tracking-tight">Edit worker</h1>
          <p className="text-[#666] text-sm">{worker.name}</p>
        </div>
        <Button size="sm" onClick={save} disabled={saving}>
          <Save className="w-4 h-4 mr-1.5" />
          {saving ? "Saving..." : "Save"}
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <div className="space-y-5">
          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <CardTitle className="text-sm font-medium">Trigger</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-sm">Type</Label>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                  {([
                    ["manual", "Manual"],
                    ["schedule", "Cron"],
                    ["webhook", "Webhook"],
                    ["composio", "Connection event"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      onClick={() => setTriggerType(value)}
                      className={`h-8 rounded-md border px-2 text-xs font-medium whitespace-nowrap transition-colors ${
                        triggerType === value
                          ? "border-black bg-black text-white"
                          : "border-[#e4e4e7] bg-white text-[#333] hover:bg-[#f4f4f5]"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {triggerType === "schedule" && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-sm">Cron</Label>
                    <Input value={cronExpr} onChange={(e) => setCronExpr(e.target.value)} className="border-[#e4e4e7] font-mono text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Timezone</Label>
                    <Input value={cronTimezone} onChange={(e) => setCronTimezone(e.target.value)} className="border-[#e4e4e7] font-mono text-sm" />
                  </div>
                </div>
              )}

              {triggerType === "composio" && (
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label className="text-sm">Search events</Label>
                    <Input value={triggerSearch} onChange={(e) => setTriggerSearch(e.target.value)} className="border-[#e4e4e7]" />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Event</Label>
                    <Select
                      value={composioEvent}
                      onValueChange={(value) => {
                        if (!value) return;
                        setComposioEvent(value);
                        setComposioConnectionId("");
                      }}
                    >
                      <SelectTrigger className="border-[#e4e4e7]">
                        <SelectValue placeholder="Select a connection event" />
                      </SelectTrigger>
                      <SelectContent>
                        {filteredComposioTriggers.map((item) => {
                          const eventId = triggerEventId(item);
                          return (
                            <SelectItem key={eventId} value={eventId}>
                              {triggerLabel(item)} · {eventId}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Connection ID</Label>
                    {matchingConnections.length > 0 ? (
                      <Select value={composioConnectionId} onValueChange={(value) => value && setComposioConnectionId(value)}>
                        <SelectTrigger className="border-[#e4e4e7]">
                          <SelectValue placeholder="Select connected account" />
                        </SelectTrigger>
                        <SelectContent>
                          {matchingConnections.map((connection) => (
                            <SelectItem key={connection.composio_connection_id} value={connection.composio_connection_id}>
                              {connection.app_name} · {connection.composio_connection_id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input value={composioConnectionId} onChange={(e) => setComposioConnectionId(e.target.value)} className="border-[#e4e4e7] font-mono text-sm" />
                    )}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-sm">Filters JSON</Label>
                    <Textarea value={composioFilters} onChange={(e) => setComposioFilters(e.target.value)} className="min-h-[90px] border-[#e4e4e7] font-mono text-xs" spellCheck={false} />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="border-[#eaeaea] shadow-none bg-white">
            <CardHeader>
              <CardTitle className="text-sm font-medium">run.py</CardTitle>
            </CardHeader>
            <CardContent>
              <Textarea value={runPy} onChange={(e) => setRunPy(e.target.value)} className="min-h-[260px] border-[#e4e4e7] font-mono text-xs" spellCheck={false} />
            </CardContent>
          </Card>
        </div>

        <Card className="border-[#eaeaea] shadow-none bg-white">
          <CardHeader>
            <CardTitle className="text-sm font-medium">worker.yml</CardTitle>
          </CardHeader>
          <CardContent>
            <Textarea value={workerYml} onChange={(e) => setWorkerYml(e.target.value)} className="min-h-[640px] border-[#e4e4e7] font-mono text-xs" spellCheck={false} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
