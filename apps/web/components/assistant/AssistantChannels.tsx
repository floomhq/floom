"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, Loader2, Plug, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type {
  AssistantChannelOption,
  AssistantChannelStatusItem,
} from "@/lib/types";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

type Provider = "slack" | "whatsapp";

const PROVIDERS: Array<{
  provider: Provider;
  name: string;
  description: string;
  targetLabel: string;
}> = [
  {
    provider: "slack",
    name: "Slack",
    description: "Bind the assistant to a workspace channel after OAuth.",
    targetLabel: "Channel",
  },
  {
    provider: "whatsapp",
    name: "WhatsApp",
    description: "Bind the assistant to a WhatsApp Business phone number after OAuth.",
    targetLabel: "Phone number",
  },
];

function readinessClass(ready: boolean) {
  return ready
    ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
    : "border-border bg-muted text-muted-foreground";
}

function ReadinessPill({ label, ready }: { label: string; ready: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium ${readinessClass(ready)}`}>
      {ready ? <CheckCircle2 className="size-3" /> : null}
      {label}
    </span>
  );
}

function connectHref(provider: Provider) {
  return `/connections/redirect?app=${encodeURIComponent(provider)}&return_to=${encodeURIComponent("/assistant#channels")}`;
}

function ChannelCard({
  item,
  reload,
}: {
  item: AssistantChannelStatusItem;
  reload: () => Promise<void>;
}) {
  const meta = PROVIDERS.find((entry) => entry.provider === item.provider)!;
  const [options, setOptions] = useState<AssistantChannelOption[]>([]);
  const [selectedId, setSelectedId] = useState(item.binding?.target_id || "");
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [saving, setSaving] = useState(false);

  const selected = useMemo(
    () => options.find((option) => option.id === selectedId),
    [options, selectedId],
  );

  const loadOptions = useCallback(async () => {
    if (!item.oauth_connected) return;
    setLoadingOptions(true);
    try {
      const result = await api.assistantChannels.options(item.provider);
      setOptions(result.options);
      if (item.binding?.target_id) {
        setSelectedId((current) => current || item.binding?.target_id || "");
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not load ${meta.name} options`);
      setOptions([]);
    } finally {
      setLoadingOptions(false);
    }
  }, [item.binding, item.oauth_connected, item.provider, meta.name]);

  useEffect(() => {
    void loadOptions();
  }, [loadOptions]);

  async function saveBinding() {
    if (!selected) {
      toast.error(`Pick a ${meta.targetLabel.toLowerCase()} first`);
      return;
    }
    setSaving(true);
    try {
      await api.assistantChannels.bind(item.provider, {
        target_id: selected.id,
        target_label: selected.label,
        metadata: selected.metadata,
      });
      toast.success(`${meta.name} binding enabled`);
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not bind ${meta.name}`);
    } finally {
      setSaving(false);
    }
  }

  async function removeBinding() {
    setSaving(true);
    try {
      await api.assistantChannels.unbind(item.provider);
      setSelectedId("");
      toast.success(`${meta.name} binding removed`);
      await reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : `Could not remove ${meta.name} binding`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-[var(--radius-card)] border border-border bg-card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] border border-border bg-background">
            <BrandLogo icon={item.provider} className="size-5" />
          </div>
          <div className="min-w-0">
            <h2 className="text-sm font-medium">{meta.name}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">{meta.description}</p>
            {item.account_label ? (
              <p className="mt-1 truncate text-[11px] text-muted-foreground">{item.account_label}</p>
            ) : null}
          </div>
        </div>
        {item.binding ? <Badge variant="default">Enabled</Badge> : <Badge variant="outline">Not bound</Badge>}
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <ReadinessPill label="OAuth" ready={item.oauth_connected} />
        <ReadinessPill label="Events" ready={item.events_configured} />
        <ReadinessPill label="Bot" ready={item.bot_configured} />
        <ReadinessPill label="Binding" ready={Boolean(item.binding)} />
      </div>

      <div className="mt-5 space-y-3">
        {!item.oauth_connected ? (
          <a href={connectHref(item.provider)} className={buttonVariants({ className: "w-full sm:w-auto" })}>
            <Plug className="size-4" />
            Connect {meta.name}
          </a>
        ) : (
          <>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Select value={selectedId} onValueChange={(value) => setSelectedId(value || "")} disabled={loadingOptions || saving}>
                <SelectTrigger>
                  <SelectValue placeholder={loadingOptions ? "Loading options" : `Pick ${meta.targetLabel.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" onClick={saveBinding} disabled={!selectedId || saving || loadingOptions}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : <CheckCircle2 className="size-4" />}
                Enable
              </Button>
            </div>
            {selected?.description ? (
              <p className="text-xs text-muted-foreground">{selected.description}</p>
            ) : item.binding ? (
              <p className="text-xs text-muted-foreground">Current binding: {item.binding.target_label || item.binding.target_id}</p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => void loadOptions()} disabled={loadingOptions || saving}>
                {loadingOptions ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
                Refresh
              </Button>
              {item.binding ? (
                <Button type="button" variant="ghost" size="sm" onClick={removeBinding} disabled={saving}>
                  <Trash2 className="size-3.5" />
                  Remove binding
                </Button>
              ) : null}
            </div>
          </>
        )}
      </div>
    </section>
  );
}

export function AssistantChannels() {
  const [channels, setChannels] = useState<AssistantChannelStatusItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await api.assistantChannels.status();
      setChannels(result.channels);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load channels");
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && channels.length === 0) {
    return (
      <div className="grid gap-4 lg:grid-cols-2">
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">Channels</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Connect OAuth, choose a live target, then enable the binding.</p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          {loading ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          Refresh
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {channels.map((item) => (
          <ChannelCard key={item.provider} item={item} reload={load} />
        ))}
      </div>
    </div>
  );
}
