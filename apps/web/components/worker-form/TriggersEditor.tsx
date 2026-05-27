"use client";

import { Plus, X, Copy, Hand, Clock as ClockIcon, Webhook, Plug as PlugIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
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

// S29e (F8.8): radio-cards-with-subtitles replaced with a single inline
// segmented control. Subtitle lives once under the picker (changes with
// the active type) so the visual hierarchy is type-picker -> config -> done.
const TRIGGER_TYPES: { value: TriggerType; label: string; icon: typeof Hand; subtitle: string }[] = [
  { value: "manual",   label: "Manual",   icon: Hand,       subtitle: "Run only on demand from the Run tab." },
  { value: "schedule", label: "Schedule", icon: ClockIcon,  subtitle: "Recurring on a cron schedule." },
  { value: "webhook",  label: "Webhook",  icon: Webhook,    subtitle: "Run when an HTTP POST hits a unique URL." },
  { value: "composio", label: "App event", icon: PlugIcon,  subtitle: "Run on an event from a connected app." },
];

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
  const activeMeta = TRIGGER_TYPES.find((t) => t.value === row.type) ?? TRIGGER_TYPES[0];

  return (
    <div className="space-y-4">
      {!isOnly && (
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            Trigger {index + 1}
          </span>
          <button
            type="button"
            onClick={onRemove}
            className="text-muted-foreground hover:text-destructive transition-colors"
            title="Remove trigger"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="space-y-2">
        <div className="inline-flex items-center rounded-md border border-line bg-card p-0.5">
          {TRIGGER_TYPES.map((t) => {
            const Icon = t.icon;
            const active = row.type === t.value;
            return (
              <button
                key={t.value}
                type="button"
                onClick={() => onChange({ ...row, type: t.value })}
                className={cn(
                  "inline-flex items-center gap-1.5 px-3 h-8 rounded text-xs font-medium transition-colors",
                  active
                    ? "bg-[color-mix(in_srgb,var(--accent)_12%,transparent)] text-[var(--accent)]"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
              >
                <Icon className="w-3.5 h-3.5" />
                {t.label}
              </button>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">{activeMeta.subtitle}</p>
      </div>

      {row.type === "schedule" && (
        <div className="space-y-3">
          <CronBuilder
            value={row.cronExpr}
            onChange={(v) => onChange({ ...row, cronExpr: v })}
          />
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground uppercase tracking-wider">Timezone</Label>
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
          <Label className="text-xs text-muted-foreground uppercase tracking-wider">Webhook URL</Label>
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
          {/* S29e: was bg-[#1a1a1a] text-[#a8e6a3] (always dark) — unreadable
              in light mode. Now theme-aware terminal block. */}
          <pre className="text-xs font-mono bg-[var(--bg-2)] dark:bg-[#1a1a1a] text-foreground dark:text-[#a8e6a3] border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {`curl -X POST '${webhookUrl}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"key": "value"}'`}
          </pre>
        </div>
      )}

      {row.type === "webhook" && !webhookUrl && (
        <div className="rounded-md border border-line bg-muted/30 p-3 space-y-2">
          <p className="text-xs text-muted-foreground font-medium">Webhook URL</p>
          <p className="text-xs text-muted-foreground">
            Your webhook URL will be shown after the worker is created. It includes a unique token for authentication.
          </p>
          <div className="rounded border border-line bg-card p-2 font-mono text-xs text-muted-foreground">
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
  // S29e (F8.8): Save/Discard moved into the editor action bar (was a
  // floating row below the card). Optional so the /workers/new flow can
  // still embed the editor without an in-place save.
  dirty?: boolean;
  saving?: boolean;
  onSave?: () => void;
  onDiscard?: () => void;
}

export function TriggersEditor({
  rows,
  onChange,
  connections = [],
  webhookUrl,
  dirty = false,
  saving = false,
  onSave,
  onDiscard,
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

  const showActionBar = Boolean(onSave) || rows.length > 0;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-medium text-foreground">Triggers</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Decide when this worker runs. Use one trigger or chain several.
        </p>
      </div>

      <div className="space-y-6">
        {rows.map((row, index) => (
          <div key={row.id} className={index > 0 ? "pt-6 border-t border-line" : ""}>
            <TriggerRowEditor
              row={row}
              index={index}
              total={rows.length}
              connections={connections}
              webhookUrl={row.type === "webhook" ? webhookUrl : undefined}
              onChange={(updated) => updateRow(index, updated)}
              onRemove={() => removeRow(index)}
            />
          </div>
        ))}
      </div>

      {showActionBar && (
        <div className="flex items-center gap-2 pt-2">
          <button
            type="button"
            onClick={addRow}
            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-line text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add trigger
          </button>
          {onSave && (
            <>
              <Button
                size="sm"
                className="h-8"
                onClick={onSave}
                disabled={!dirty || saving}
              >
                {saving ? "Saving..." : "Save triggers"}
              </Button>
              {onDiscard && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8"
                  onClick={onDiscard}
                  disabled={!dirty || saving}
                >
                  Discard
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
