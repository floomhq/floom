"use client";

import { Plus, X, Copy } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { CronBuilder } from "@/components/CronBuilder";
import { ConnectionEventPicker } from "@/components/ConnectionEventPicker";
import type { ConnectionItem, TriggerSpec } from "@/lib/types";

export type TriggerType = "manual" | "schedule" | "webhook" | "composio";

export interface TriggerRow {
  id: string;
  type: TriggerType;
  cronExpr: string;
  cronTimezone: string;
  composioEvent: string;
  composioConnectionId: string;
}

export function makeTriggerRow(spec?: TriggerSpec): TriggerRow {
  return {
    id: Math.random().toString(36).slice(2),
    type: ((spec?.type as TriggerType) || "manual"),
    cronExpr: spec?.cron || "0 9 * * MON",
    cronTimezone: spec?.timezone || "Europe/Berlin",
    composioEvent: spec?.composio?.event || "",
    composioConnectionId: spec?.composio?.connection_id || "",
  };
}

export function defaultTriggerRow(): TriggerRow {
  return makeTriggerRow(undefined);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function buildSingleTriggerYaml(row: TriggerRow): string {
  const lines = [`  - type: ${row.type}`];
  if (row.type === "schedule") {
    lines.push(`    cron: ${yamlString(row.cronExpr || "0 9 * * *")}`);
    lines.push(`    timezone: ${yamlString(row.cronTimezone || "Europe/Berlin")}`);
  }
  if (row.type === "webhook") {
    lines.push(`    webhook:`);
    lines.push(`      secret: true`);
    lines.push(`      allowed_methods: [POST]`);
  }
  if (row.type === "composio") {
    lines.push(`    composio:`);
    lines.push(`      event: ${yamlString(row.composioEvent)}`);
    lines.push(`      connection_id: ${yamlString(row.composioConnectionId)}`);
    lines.push(`      filters: {}`);
  }
  return lines.join("\n");
}

export function buildTriggersYaml(rows: TriggerRow[]): string {
  if (rows.length === 1) {
    const row = rows[0];
    const lines = [`trigger:`, `  type: ${row.type}`];
    if (row.type === "schedule") {
      lines.push(`  cron: ${yamlString(row.cronExpr || "0 9 * * *")}`);
      lines.push(`  timezone: ${yamlString(row.cronTimezone || "Europe/Berlin")}`);
    }
    if (row.type === "webhook") {
      lines.push(`  webhook:`);
      lines.push(`    secret: true`);
      lines.push(`    allowed_methods: [POST]`);
    }
    if (row.type === "composio") {
      lines.push(`  composio:`);
      lines.push(`    event: ${yamlString(row.composioEvent)}`);
      lines.push(`    connection_id: ${yamlString(row.composioConnectionId)}`);
      lines.push(`    filters: {}`);
    }
    return lines.join("\n");
  }

  const lines = [`triggers:`];
  for (const row of rows) {
    lines.push(buildSingleTriggerYaml(row));
  }
  return lines.join("\n");
}

export function replaceTriggerBlock(yaml: string, triggerYaml: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => /^triggers?:\s*$/.test(line));
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

// ---------------------------------------------------------------------------
// TriggerRowEditor — single trigger row UI
// ---------------------------------------------------------------------------

interface TriggerRowEditorProps {
  row: TriggerRow;
  index: number;
  total: number;
  connections: ConnectionItem[];
  webhookUrl?: string;
  onChange: (updated: TriggerRow) => void;
  onRemove: () => void;
}

function TriggerRowEditor({
  row,
  index,
  total,
  connections,
  webhookUrl,
  onChange,
  onRemove,
}: TriggerRowEditorProps) {
  const isOnly = total === 1;

  return (
    <div className="rounded-md border border-border bg-muted/30 p-3 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          Trigger {total > 1 ? index + 1 : ""}
        </span>
        {!isOnly && (
          <button
            type="button"
            onClick={onRemove}
            className="text-muted-foreground hover:text-red-500 transition-colors"
            title="Remove trigger"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(["manual", "schedule", "webhook", "composio"] as const).map((value) => {
          const labels: Record<string, string> = {
            manual: "Manual",
            schedule: "Cron",
            webhook: "Webhook",
            composio: "Connection event",
          };
          return (
            <button
              key={value}
              type="button"
              onClick={() => onChange({ ...row, type: value })}
              className={`h-8 rounded-md border px-2 text-xs font-medium whitespace-nowrap transition-colors ${
                row.type === value
                  ? "border-black bg-black text-white"
                  : "border-border bg-card text-foreground hover:bg-muted"
              }`}
            >
              {labels[value]}
            </button>
          );
        })}
      </div>

      {row.type === "schedule" && (
        <div className="space-y-3">
          <CronBuilder
            value={row.cronExpr}
            onChange={(v) => onChange({ ...row, cronExpr: v })}
          />
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wide">Timezone</Label>
            <Input
              value={row.cronTimezone}
              onChange={(e) => onChange({ ...row, cronTimezone: e.target.value })}
              className="border-border font-mono text-sm"
              placeholder="Europe/Berlin"
            />
          </div>
        </div>
      )}

      {row.type === "composio" && (
        <ConnectionEventPicker
          composioEvent={row.composioEvent}
          composioConnectionId={row.composioConnectionId}
          onEventChange={(v) => onChange({ ...row, composioEvent: v })}
          onConnectionIdChange={(v) => onChange({ ...row, composioConnectionId: v })}
          initialConnections={connections}
        />
      )}

      {row.type === "webhook" && webhookUrl && (
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground uppercase tracking-wide">Webhook URL</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-muted border border-border rounded px-2 py-1.5 break-all">
              {webhookUrl}
            </code>
            <button
              type="button"
              title="Copy URL"
              onClick={() => {
                navigator.clipboard.writeText(webhookUrl).then(
                  () => toast.success("URL copied"),
                  () => toast.error("Failed to copy"),
                );
              }}
              className="shrink-0 p-1.5 rounded border border-border bg-card hover:bg-muted transition-colors"
            >
              <Copy className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
          <pre className="text-xs font-mono bg-[#1a1a1a] text-[#a8e6a3] rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {`curl -X POST '${webhookUrl}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"key": "value"}'`}
          </pre>
        </div>
      )}

      {row.type === "webhook" && !webhookUrl && (
        <div className="rounded-md border border-border bg-muted/30 p-3 space-y-2">
          <p className="text-xs text-muted-foreground font-medium">Webhook URL</p>
          <p className="text-xs text-muted-foreground">
            Your webhook URL will be shown after the worker is created. It includes a unique token for authentication.
          </p>
          <div className="rounded border border-border bg-card p-2 font-mono text-xs text-muted-foreground">
            https://workers-api.floom.dev/webhooks/&lt;worker-id&gt;?token=...
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TriggersEditor — full multi-trigger editor card
// ---------------------------------------------------------------------------

interface TriggersEditorProps {
  rows: TriggerRow[];
  onChange: (rows: TriggerRow[]) => void;
  connections?: ConnectionItem[];
  webhookUrl?: string;
}

export function TriggersEditor({
  rows,
  onChange,
  connections = [],
  webhookUrl,
}: TriggersEditorProps) {
  function updateRow(index: number, updated: TriggerRow) {
    onChange(rows.map((r, i) => (i === index ? updated : r)));
  }

  function addRow() {
    onChange([...rows, defaultTriggerRow()]);
  }

  function removeRow(index: number) {
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <Card className="border-border shadow-none bg-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Triggers</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.map((row, index) => (
          <TriggerRowEditor
            key={row.id}
            row={row}
            index={index}
            total={rows.length}
            connections={connections}
            webhookUrl={row.type === "webhook" ? webhookUrl : undefined}
            onChange={(updated) => updateRow(index, updated)}
            onRemove={() => removeRow(index)}
          />
        ))}
        <button
          type="button"
          onClick={addRow}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-black transition-colors py-1"
        >
          <Plus className="w-3.5 h-3.5" />
          Add trigger
        </button>
      </CardContent>
    </Card>
  );
}
