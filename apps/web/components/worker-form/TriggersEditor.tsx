"use client";

import { useState } from "react";
import { Plus, X, Copy, Hand, Clock as ClockIcon, Webhook, Plug as PlugIcon, Pencil } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { getPublicApiBase } from "@/lib/api-base";
import { CronBuilder } from "@/components/CronBuilder";
import { humanizeCron } from "@/lib/humanize-cron";
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

function normalizeTriggerType(value?: string): TriggerType {
  if (value === "cron" || value === "scheduled") return "schedule";
  if (value === "schedule" || value === "webhook" || value === "composio" || value === "manual") {
    return value;
  }
  return "manual";
}

export function makeTriggerRow(spec?: TriggerSpec): TriggerRow {
  return {
    id: Math.random().toString(36).slice(2),
    type: normalizeTriggerType(spec?.type),
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
// Kind metadata — icons + labels used in both the picker and the summary row
// ---------------------------------------------------------------------------

const TRIGGER_TYPES: { value: TriggerType; label: string; icon: typeof Hand; subtitle: string }[] = [
  { value: "manual",   label: "Manual",    icon: Hand,       subtitle: "Run only on demand from the Run tab." },
  { value: "schedule", label: "Schedule",  icon: ClockIcon,  subtitle: "Recurring on a cron schedule." },
  { value: "webhook",  label: "Webhook",   icon: Webhook,    subtitle: "Run when an HTTP POST hits a unique URL." },
  { value: "composio", label: "App event", icon: PlugIcon,   subtitle: "Run on an event from a connected app." },
];

function kindMeta(type: TriggerType) {
  return TRIGGER_TYPES.find((t) => t.value === type) ?? TRIGGER_TYPES[0];
}

// ---------------------------------------------------------------------------
// Summary headline helpers (ported from the deleted ConfiguredTriggersSummary)
// ---------------------------------------------------------------------------

// Returns the readable summary plus, for schedules, the raw cron expression so
// callers can surface it as a tooltip for power users.
function triggerSummaryLine(row: TriggerRow): { text: string; title?: string } {
  if (row.type === "schedule") {
    const cron = row.cronExpr || "0 9 * * *";
    const tz = row.cronTimezone || "UTC";
    return { text: humanizeCron(cron, tz), title: `${cron} ${tz}` };
  }
  if (row.type === "webhook") return { text: "HTTP POST endpoint" };
  if (row.type === "composio") {
    if (row.composioEvent) return { text: row.composioEvent };
    return { text: "Connected app event" };
  }
  return { text: "Manual run" };
}

// ---------------------------------------------------------------------------
// TriggerRowSummary — collapsed one-line view with edit / remove buttons
// ---------------------------------------------------------------------------

interface TriggerRowSummaryProps {
  row: TriggerRow;
  onEdit: () => void;
  onRemove: () => void;
}

function TriggerRowSummary({ row, onEdit, onRemove }: TriggerRowSummaryProps) {
  const meta = kindMeta(row.type);
  const Icon = meta.icon;
  const summary = triggerSummaryLine(row);

  return (
    <div className="flex items-center gap-3 py-2.5 px-3 rounded-[var(--radius-ui)] bg-card hover:bg-muted/30 transition-colors group">
      <Icon className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0 flex items-center gap-2 overflow-hidden">
        <span className="text-xs font-medium text-foreground shrink-0">{meta.label}</span>
        <span className="text-muted-foreground text-xs select-none">·</span>
        <span className="text-xs text-muted-foreground truncate" title={summary.title}>{summary.text}</span>
      </div>
      <div className="flex items-center gap-0.5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-foreground"
          onClick={onEdit}
          title="Edit trigger"
        >
          <Pencil className="w-3 h-3" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
          onClick={onRemove}
          title="Remove trigger"
        >
          <X className="w-3 h-3" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TriggerRowEditor — single trigger row expanded UI (unchanged logic)
// ---------------------------------------------------------------------------

interface TriggerRowEditorProps {
  row: TriggerRow;
  connections: ConnectionItem[];
  webhookUrl?: string;
  onChange: (updated: TriggerRow) => void;
  onCollapse: () => void;
  onRemove: () => void;
}

// S29e (F8.8): radio-cards-with-subtitles replaced with a single inline
// segmented control. Subtitle lives once under the picker (changes with
// the active type) so the visual hierarchy is type-picker -> config -> done.
function TriggerRowEditor({
  row,
  connections,
  webhookUrl,
  onChange,
  onCollapse,
  onRemove,
}: TriggerRowEditorProps) {
  const activeMeta = TRIGGER_TYPES.find((t) => t.value === row.type) ?? TRIGGER_TYPES[0];

  return (
    <div className="rounded-[var(--radius-ui)] bg-card p-4 space-y-4">
      {/* header: kind label + collapse + remove */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium text-muted-foreground">Edit trigger</span>
        <div className="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground hover:text-foreground"
            onClick={onCollapse}
          >
            Done
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
            onClick={onRemove}
            title="Remove trigger"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <div className="inline-flex items-center rounded-[var(--radius-ui)] bg-card p-0.5">
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
            <Label className="text-xs text-muted-foreground">Timezone</Label>
            <Input
              value={row.cronTimezone}
              onChange={(e) => onChange({ ...row, cronTimezone: e.target.value })}
              className=" font-mono text-sm"
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
          <Label className="text-xs text-muted-foreground">Webhook URL</Label>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs font-mono bg-muted rounded px-2 py-1.5 break-all">
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
              className="shrink-0 p-1.5 rounded bg-card hover:bg-muted transition-colors"
            >
              <Copy className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
          {/* S29e: was bg-[#1a1a1a] text-[#a8e6a3] (always dark) — unreadable
              in light mode. Now theme-aware terminal block. */}
          <pre className="text-xs font-mono bg-[var(--bg-2)] dark:bg-[#1a1a1a] text-foreground dark:text-[#a8e6a3] rounded p-2 overflow-x-auto whitespace-pre-wrap">
            {`curl -X POST '${webhookUrl}' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"key": "value"}'`}
          </pre>
        </div>
      )}

      {row.type === "webhook" && !webhookUrl && (
        <div className="rounded-[var(--radius-ui)] bg-muted/30 p-3 space-y-2">
          <p className="text-xs text-muted-foreground font-medium">Webhook URL</p>
          <p className="text-xs text-muted-foreground">
            Your webhook URL will be shown after the worker is created. It includes a unique token for authentication.
          </p>
          <div className="rounded bg-card p-2 font-mono text-xs text-muted-foreground">
            {`${getPublicApiBase()}/webhooks/<worker-id>?token=...`}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TriggersEditor — list-of-triggers with + Add trigger at the top
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
  // Track which row IDs are currently expanded (open for editing)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  function isExpanded(id: string) {
    return expandedIds.has(id);
  }

  function expand(id: string) {
    setExpandedIds((prev) => new Set([...prev, id]));
  }

  function collapse(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
  }

  function updateRow(index: number, updated: TriggerRow) {
    onChange(rows.map((r, i) => (i === index ? updated : r)));
  }

  function addRow() {
    const newRow = defaultTriggerRow();
    // New trigger goes to the top, starts expanded
    onChange([newRow, ...rows]);
    setExpandedIds((prev) => new Set([newRow.id, ...prev]));
  }

  function removeRow(index: number) {
    const removed = rows[index];
    collapse(removed.id);
    onChange(rows.filter((_, i) => i !== index));
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-sm font-medium text-foreground">Triggers</h2>
        <p className="text-xs text-muted-foreground mt-0.5">
          Decide when this worker runs. Use one trigger or chain several.
        </p>
      </div>

      {/* Primary action: + Add trigger — ABOVE the list (the operator 2026-05-29 explicit) */}
      <button
        type="button"
        onClick={addRow}
        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-[var(--radius-ui)] text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors"
      >
        <Plus className="w-3.5 h-3.5" />
        Add trigger
      </button>

      {/* Trigger list */}
      {rows.length === 0 ? (
        <div className="space-y-2 rounded-[var(--radius-ui)] p-8 text-center">
          <p className="text-sm text-muted-foreground">This worker has no triggers.</p>
          <p className="text-xs text-muted-foreground">Add one to schedule it or connect an event.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {rows.map((row, index) =>
            isExpanded(row.id) ? (
              <TriggerRowEditor
                key={row.id}
                row={row}
                connections={connections}
                webhookUrl={row.type === "webhook" ? webhookUrl : undefined}
                onChange={(updated) => updateRow(index, updated)}
                onCollapse={() => collapse(row.id)}
                onRemove={() => removeRow(index)}
              />
            ) : (
              <TriggerRowSummary
                key={row.id}
                row={row}
                onEdit={() => expand(row.id)}
                onRemove={() => removeRow(index)}
              />
            )
          )}
        </div>
      )}

      {/* Save / Discard action bar. P2-5: only render once there's an unsaved
          change (or a save in flight). A view-like tab with no edits should
          not show editing chrome. */}
      {onSave && (dirty || saving) && (
        <div className="flex items-center gap-2 pt-2">
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
        </div>
      )}
    </div>
  );
}
