"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { openOAuthPopup } from "@/lib/oauth-popup";
import { getSupportedApp } from "@/components/connections/connection-data";
import type { DraftRequirementItem } from "@/lib/types";

// ---------------------------------------------------------------------------
// InlineSecretRow
// ---------------------------------------------------------------------------

interface InlineSecretRowProps {
  name: string;
  initialStatus: "set" | "missing" | "unknown";
  onSaved: (name: string) => void;
}

function InlineSecretRow({ name, initialStatus, onSaved }: InlineSecretRowProps) {
  const [status, setStatus] = useState<"set" | "missing" | "unknown" | "saving">(initialStatus);
  const [value, setValue] = useState("");
  const [showInput, setShowInput] = useState(initialStatus !== "set");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showInput && inputRef.current) inputRef.current.focus();
  }, [showInput]);

  async function handleSave() {
    const trimmed = value.trim();
    if (!trimmed) { toast.error(`Enter a value for ${name}`); return; }
    setStatus("saving");
    try {
      await api.secrets.upsert(name, trimmed);
      setStatus("set");
      setShowInput(false);
      setValue("");
      onSaved(name);
      toast.success(`${name} saved`);
    } catch (e: unknown) {
      setStatus("missing");
      toast.error(e instanceof Error ? e.message : `Failed to save ${name}`);
    }
  }

  if (status === "set") {
    return (
      <div className="flex items-center justify-between rounded-[var(--radius-ui)] bg-[color-mix(in_srgb,var(--positive)_10%,transparent)] px-3 py-2">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-[var(--positive)] flex-shrink-0" />
          <span className="text-sm font-mono font-medium text-[var(--positive)]">{name}</span>
          <span className="text-xs text-[var(--positive)]">Set</span>
        </div>
        <button type="button" onClick={() => { setStatus("missing"); setShowInput(true); }} className="text-xs text-muted-foreground hover:text-muted-foreground transition-colors">
          Change
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius-ui)] bg-card p-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-sm font-mono font-medium text-foreground">{name}</span>
        <span className="rounded-[var(--radius-ui)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-1.5 py-0.5 text-xs text-[var(--warning)]">required</span>
      </div>
      {showInput && (
        <div className="flex gap-2">
          <Input
            ref={inputRef}
            type="password"
            placeholder={`Enter ${name}`}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="flex-1 font-mono text-sm"
            disabled={status === "saving"}
            onKeyDown={(e) => { if (e.key === "Enter") handleSave(); }}
          />
          <Button size="sm" onClick={handleSave} disabled={status === "saving" || !value.trim()} className="shrink-0">
            {status === "saving" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// InlineRequirementRow — unified row for one integration (OAuth or API key)
// ---------------------------------------------------------------------------

interface InlineRequirementRowProps {
  requirement: DraftRequirementItem;
  secretName?: string;
  initialSecretStatus?: "set" | "missing" | "unknown";
  initialConnected?: boolean;
  onReady: (app: string) => void;
  onMethodChange: (app: string, method: "oauth" | "api_key") => void;
}

function InlineRequirementRow({
  requirement,
  secretName,
  initialSecretStatus = "unknown",
  initialConnected = false,
  onReady,
  onMethodChange,
}: InlineRequirementRowProps) {
  const app = getSupportedApp(requirement.app);
  const isOAuth = requirement.method === "oauth";
  const availMethods = requirement.available_methods ?? [];
  const canToggle = availMethods.length === 2;

  const [connStatus, setConnStatus] = useState<"connected" | "disconnected" | "connecting">(
    initialConnected ? "connected" : "disconnected"
  );

  const effectiveSecretName = requirement.method === "api_key"
    ? (secretName ?? `${requirement.app.toUpperCase().replace(/-/g, "_")}_API_KEY`)
    : undefined;
  const [secretStatus, setSecretStatus] = useState<"set" | "missing" | "unknown" | "saving">(initialSecretStatus);
  const [secretValue, setSecretValue] = useState("");
  const [showSecretInput, setShowSecretInput] = useState(initialSecretStatus !== "set");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (showSecretInput && inputRef.current) inputRef.current.focus();
  }, [showSecretInput]);

  const prevMethod = useRef(requirement.method);
  useEffect(() => {
    if (prevMethod.current !== requirement.method) {
      prevMethod.current = requirement.method;
      setConnStatus("disconnected");
      setSecretStatus("unknown");
      setSecretValue("");
      setShowSecretInput(true);
    }
  }, [requirement.method]);

  const isReady = isOAuth ? connStatus === "connected" : secretStatus === "set";

  useEffect(() => {
    if (isReady) onReady(requirement.app);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isReady]);

  async function handleConnect() {
    setConnStatus("connecting");
    try {
      const result = await api.connections.initiate(requirement.app);
      if (!result.redirect_url) {
        toast.error(`No OAuth URL returned for ${app.displayName}`);
        setConnStatus("disconnected");
        return;
      }
      const outcome = await openOAuthPopup({
        oauthUrl: result.redirect_url,
        appSlug: requirement.app,
        onConnected: () => {
          setConnStatus("connected");
          onReady(requirement.app);
          toast.success(`${app.displayName} connected`);
        },
      });
      if (outcome === "timeout") {
        toast.error("Connection timed out. Complete the OAuth flow and retry.");
        setConnStatus("disconnected");
      } else if (outcome === "closed") {
        const connections = await api.connections.list();
        const active = connections.find(
          (c) => c.app_name.toLowerCase() === requirement.app.toLowerCase() && c.status === "active"
        );
        if (active) {
          setConnStatus("connected");
          onReady(requirement.app);
          toast.success(`${app.displayName} connected`);
        } else {
          setConnStatus("disconnected");
        }
      }
    } catch (e: unknown) {
      setConnStatus("disconnected");
      toast.error(e instanceof Error ? e.message : `Failed to connect ${app.displayName}`);
    }
  }

  async function handleSaveSecret() {
    const trimmed = secretValue.trim();
    if (!trimmed || !effectiveSecretName) {
      toast.error(`Enter a value for ${effectiveSecretName ?? "the API key"}`);
      return;
    }
    setSecretStatus("saving");
    try {
      await api.secrets.upsert(effectiveSecretName, trimmed);
      setSecretStatus("set");
      setShowSecretInput(false);
      setSecretValue("");
      onReady(requirement.app);
      toast.success(`${effectiveSecretName} saved`);
    } catch (e: unknown) {
      setSecretStatus("missing");
      toast.error(e instanceof Error ? e.message : `Failed to save ${effectiveSecretName}`);
    }
  }

  const methodToggle = canToggle ? (
    <div className="flex items-center rounded overflow-hidden text-xs font-mono">
      {(["oauth", "api_key"] as const).map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => onMethodChange(requirement.app, m)}
          className={`px-2 py-0.5 transition-colors ${
            requirement.method === m
              ? m === "oauth" ? "bg-[var(--primary)] text-[var(--primary-text)]" : "bg-[var(--accent)] text-white"
              : "bg-card text-muted-foreground hover:bg-muted"
          }`}
        >
          {m === "oauth" ? "OAuth" : "API key"}
        </button>
      ))}
    </div>
  ) : (
    <span className={`rounded-[var(--radius-ui)] px-1.5 py-0.5 font-mono text-xs ${
      isOAuth
        ? "bg-[color-mix(in_srgb,var(--primary)_9%,transparent)] text-[var(--primary)]"
        : "bg-[color-mix(in_srgb,var(--accent)_9%,transparent)] text-[var(--accent)]"
    }`}>
      {isOAuth ? "OAuth" : "API key"}
    </span>
  );

  if (isReady) {
    return (
      <div className="space-y-2 rounded-[var(--radius-ui)] bg-[color-mix(in_srgb,var(--positive)_10%,transparent)] p-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-[var(--positive)] flex-shrink-0" />
            <span className="text-sm font-medium text-[var(--positive)]">{app.displayName}</span>
            {methodToggle}
          </div>
          {isOAuth ? (
            <button type="button" onClick={handleConnect} className="text-xs text-muted-foreground hover:text-muted-foreground transition-colors">
              Reconnect
            </button>
          ) : (
            <button
              type="button"
              onClick={() => { setSecretStatus("missing"); setShowSecretInput(true); }}
              className="text-xs text-muted-foreground hover:text-muted-foreground transition-colors"
            >
              Change
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--radius-ui)] bg-card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-foreground">{app.displayName}</span>
          {methodToggle}
        </div>
        {isOAuth && (
          <Button size="sm" variant="outline" onClick={handleConnect} disabled={connStatus === "connecting"} className="shrink-0 h-7 text-xs">
            {connStatus === "connecting" ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="w-3 h-3 animate-spin" />
                Connecting...
              </span>
            ) : `Connect ${app.displayName}`}
          </Button>
        )}
      </div>
      {!isOAuth && effectiveSecretName && (
        <>
          <div className="flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground">{effectiveSecretName}</span>
            <span className="rounded-[var(--radius-ui)] bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] px-1.5 py-0.5 text-xs text-[var(--warning)]">required</span>
          </div>
          {showSecretInput && (
            <div className="flex gap-2">
              <Input
                ref={inputRef}
                type="password"
                placeholder={`Enter ${effectiveSecretName}`}
                value={secretValue}
                onChange={(e) => setSecretValue(e.target.value)}
                className="flex-1 font-mono text-sm"
                disabled={secretStatus === "saving"}
                onKeyDown={(e) => { if (e.key === "Enter") handleSaveSecret(); }}
              />
              <Button size="sm" onClick={handleSaveSecret} disabled={secretStatus === "saving" || !secretValue.trim()} className="shrink-0">
                {secretStatus === "saving" ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : "Save"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// RequirementsEditor — the full requirements panel
// ---------------------------------------------------------------------------

interface SecretState { name: string; status: "set" | "missing" | "unknown"; }
interface ConnectionState { slug: string; connected: boolean; }

interface RequirementsEditorProps {
  requirements?: DraftRequirementItem[];
  requiredSecrets: string[];
  requiredConnections: string[];
  onAllReady: (ready: boolean) => void;
  onRequirementsChange?: (updated: DraftRequirementItem[]) => void;
  skipped: boolean;
  onSkip: () => void;
}

export function RequirementsEditor({
  requirements,
  requiredSecrets,
  requiredConnections,
  onAllReady,
  onRequirementsChange,
  skipped,
  onSkip,
}: RequirementsEditorProps) {
  const [loading, setLoading] = useState(true);
  const [localRequirements, setLocalRequirements] = useState<DraftRequirementItem[]>(
    requirements ?? []
  );
  const [secretStates, setSecretStates] = useState<SecretState[]>(
    requiredSecrets.map((name) => ({ name, status: "unknown" as const }))
  );
  const [connectionStates, setConnectionStates] = useState<ConnectionState[]>(
    requiredConnections.map((slug) => ({ slug, connected: false }))
  );
  const [readyApps, setReadyApps] = useState<Set<string>>(new Set());

  const useNewFormat = Array.isArray(requirements) && requirements.length > 0;

  useEffect(() => {
    let cancelled = false;
    async function checkStatus() {
      try {
        const allSecrets = useNewFormat
          ? requirements!.filter((r) => r.method === "api_key").map((r) => `${r.app.toUpperCase().replace(/-/g, "_")}_API_KEY`)
          : requiredSecrets;
        const allConnections = useNewFormat
          ? requirements!.filter((r) => r.method === "oauth").map((r) => r.app)
          : requiredConnections;

        const [secretList, connectionList] = await Promise.all([
          allSecrets.length > 0 ? api.secrets.list() : Promise.resolve([]),
          allConnections.length > 0 ? api.connections.list() : Promise.resolve([]),
        ]);

        if (cancelled) return;

        const secretMap = new Map(secretList.map((s) => [s.name, s.status]));
        const activeConnections = new Set(
          connectionList.filter((c) => c.status === "active").map((c) => c.app_name.toLowerCase())
        );

        if (useNewFormat) {
          const preReady = new Set<string>();
          for (const req of requirements!) {
            if (req.method === "oauth" && activeConnections.has(req.app.toLowerCase())) {
              preReady.add(req.app);
            } else if (req.method === "api_key") {
              const secretName = `${req.app.toUpperCase().replace(/-/g, "_")}_API_KEY`;
              if ((secretMap.get(secretName) ?? "missing") === "set") preReady.add(req.app);
            }
          }
          setReadyApps(preReady);
        } else {
          setSecretStates(
            requiredSecrets.map((name) => ({
              name,
              status: (secretMap.get(name) ?? "missing") as "set" | "missing",
            }))
          );
          setConnectionStates(
            requiredConnections.map((slug) => ({
              slug,
              connected: activeConnections.has(slug.toLowerCase()),
            }))
          );
        }
      } catch {
        // API errors: show all as unknown/disconnected so user can still proceed
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void checkStatus();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const allReady = useNewFormat
    ? localRequirements.every((r) => readyApps.has(r.app))
    : secretStates.every((s) => s.status === "set") && connectionStates.every((c) => c.connected);

  useEffect(() => { onAllReady(allReady); }, [allReady, onAllReady]);

  function handleSecretSaved(name: string) {
    setSecretStates((prev) => prev.map((s) => (s.name === name ? { ...s, status: "set" } : s)));
  }

  function handleConnectionConnected(slug: string) {
    setConnectionStates((prev) => prev.map((c) => (c.slug === slug ? { ...c, connected: true } : c)));
  }

  function handleRequirementReady(app: string) {
    setReadyApps((prev) => new Set([...prev, app]));
  }

  function handleMethodChange(app: string, method: "oauth" | "api_key") {
    setLocalRequirements((prev) => {
      const updated = prev.map((r) => r.app === app ? { ...r, method } : r);
      onRequirementsChange?.(updated);
      return updated;
    });
    setReadyApps((prev) => { const next = new Set(prev); next.delete(app); return next; });
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="w-4 h-4 animate-spin" />
        Checking existing secrets and connections...
      </div>
    );
  }

  const hasRequirements = useNewFormat
    ? localRequirements.length > 0
    : requiredSecrets.length > 0 || requiredConnections.length > 0;
  if (!hasRequirements) return null;

  return (
    <Card className=" shadow-none bg-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm font-medium">
            {allReady ? (
              <span className="flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4 text-[var(--positive)]" />
                Requirements ready
              </span>
            ) : "Set up requirements"}
          </CardTitle>
          {!allReady && !skipped && (
            <button type="button" onClick={onSkip} className="text-xs text-muted-foreground hover:text-muted-foreground transition-colors">
              Skip for now
            </button>
          )}
        </div>
        {!allReady && !skipped && (
          <p className="text-xs text-muted-foreground mt-0.5">
            Connect the integrations this worker needs before creating it.
          </p>
        )}
        {skipped && (
          <p className="mt-0.5 text-xs text-[var(--warning)]">
            Skipped. You can configure these later in Settings / Connections.
          </p>
        )}
      </CardHeader>
      {!skipped && (
        <CardContent className="space-y-2">
          {useNewFormat ? (
            localRequirements.map((req) => {
              const secretName = req.method === "api_key"
                ? `${req.app.toUpperCase().replace(/-/g, "_")}_API_KEY`
                : undefined;
              return (
                <InlineRequirementRow
                  key={req.app}
                  requirement={req}
                  secretName={secretName}
                  initialSecretStatus="unknown"
                  initialConnected={readyApps.has(req.app)}
                  onReady={handleRequirementReady}
                  onMethodChange={handleMethodChange}
                />
              );
            })
          ) : (
            <>
              {requiredSecrets.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground ">API keys</Label>
                  <div className="space-y-2">
                    {secretStates.map((s) => (
                      <InlineSecretRow key={s.name} name={s.name} initialStatus={s.status} onSaved={handleSecretSaved} />
                    ))}
                  </div>
                </div>
              )}
              {requiredConnections.length > 0 && (
                <div className="space-y-2">
                  <Label className="text-xs text-muted-foreground ">OAuth connections</Label>
                  <div className="space-y-2">
                    {connectionStates.map((c) => {
                      const appData = getSupportedApp(c.slug);
                      return (
                        <div key={c.slug} className="flex items-center justify-between py-2 px-3 rounded-[var(--radius-ui)] bg-card">
                          <span className="text-sm font-medium text-foreground">{appData.displayName}</span>
                          {c.connected ? (
                            <div className="flex items-center gap-2">
                              <CheckCircle2 className="w-4 h-4 text-[var(--positive)]" />
                              <span className="text-xs text-[var(--positive)]">Connected</span>
                            </div>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={async () => {
                                try {
                                  const result = await api.connections.initiate(c.slug);
                                  if (!result.redirect_url) return;
                                  await openOAuthPopup({
                                    oauthUrl: result.redirect_url,
                                    appSlug: c.slug,
                                    onConnected: () => {
                                      handleConnectionConnected(c.slug);
                                      toast.success(`${appData.displayName} connected`);
                                    },
                                  });
                                } catch (e: unknown) {
                                  toast.error(e instanceof Error ? e.message : `Failed to connect ${appData.displayName}`);
                                }
                              }}
                              className="shrink-0 h-7 text-xs"
                            >
                              Connect {appData.displayName}
                            </Button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}
