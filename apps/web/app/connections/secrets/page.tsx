"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { api } from "@/lib/api";
import { useSecrets, useWorkers } from "@/lib/query/hooks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatusPill } from "@/components/collection/StatusPill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyRound, TestTube2, Trash2, Plus, Check, X, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { ConnectionsTabs } from "@/components/connections/ConnectionsTabs";
import { formatRelativeTime } from "@/components/connections/connection-data";
import { useIsAdmin } from "@/lib/use-is-admin";

export default function SecretsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">Loading secrets...</div>}>
      <SecretsContent />
    </Suspense>
  );
}

// How many "used by" workers to show before truncating on mobile
const USED_BY_INITIAL_COUNT = 2;

function SecretsContent() {
  // S24: ?prefill=NAME from /connections/browse -> opens add form pre-filled.
  const searchParams = useSearchParams();
  const prefillName = searchParams.get("prefill") ?? "";
  // #943 — the secret inventory (names + which workers use them) maps the
  // workspace's vendors and operational gaps. Owner/admin only.
  const { isAdmin, pending: roleCheckPending } = useIsAdmin();
  const secretsQuery = useSecrets(undefined, isAdmin && !roleCheckPending);
  const workersQuery = useWorkers(undefined, undefined, isAdmin && !roleCheckPending);
  const { refetch: refetchSecrets } = secretsQuery;
  const { refetch: refetchWorkers } = workersQuery;
  const secrets = isAdmin ? (secretsQuery.data ?? []) : [];
  const workers = workersQuery.data ?? [];
  const loading =
    isAdmin &&
    ((secretsQuery.isLoading && !secretsQuery.data) || (workersQuery.isLoading && !workersQuery.data));
  const [addingName, setAddingName] = useState(prefillName);
  const [addingValue, setAddingValue] = useState("");
  const [addingOpen, setAddingOpen] = useState(Boolean(prefillName));
  const [saving, setSaving] = useState(false);
  const [testingName, setTestingName] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { status: string; reason?: string }>>({});
  const [updatingName, setUpdatingName] = useState<string | null>(null);
  const [updatingValue, setUpdatingValue] = useState("");
  const [deletingName, setDeletingName] = useState<string | null>(null);
  // Track which secrets have their "used by" list expanded on mobile
  const [expandedUsedBy, setExpandedUsedBy] = useState<Set<string>>(new Set());

  // #1226: name -> worker id for clickable used-by links
  const workersByName = useMemo(
    () => new Map(workers.map((w) => [w.name, w.id])),
    [workers],
  );

  const refresh = useCallback(async () => {
    if (!isAdmin) return;
    try {
      await Promise.allSettled([refetchSecrets(), refetchWorkers()]);
    } catch {
      toast.error("Failed to load secrets");
    }
  }, [isAdmin, refetchSecrets, refetchWorkers]);

  useEffect(() => {
    if (!roleCheckPending && isAdmin && secretsQuery.isError && !secretsQuery.data) {
      toast.error("Failed to load secrets");
    }
  }, [roleCheckPending, isAdmin, secretsQuery.isError, secretsQuery.data]);

  async function handleAdd() {
    if (!addingName.trim() || !addingValue.trim()) {
      toast.error("Name and value are required");
      return;
    }
    setSaving(true);
    try {
      await api.secrets.upsert(addingName.trim(), addingValue.trim());
      toast.success(`Secret ${addingName.trim()} saved`);
      setAddingName("");
      setAddingValue("");
      setAddingOpen(false);
      void refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to save secret");
    } finally {
      setSaving(false);
    }
  }

  async function handleUpdate(name: string) {
    if (!updatingValue.trim()) {
      toast.error("Value required");
      return;
    }
    setSaving(true);
    try {
      await api.secrets.upsert(name, updatingValue.trim());
      toast.success(`Secret ${name} updated`);
      setUpdatingName(null);
      setUpdatingValue("");
      void refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update secret");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(name: string) {
    setDeletingName(name);
    try {
      await api.secrets.delete(name);
      toast.success(`Secret ${name} removed`);
      setTestResults((prev) => { const n = { ...prev }; delete n[name]; return n; });
      void refresh();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to delete secret");
    } finally {
      setDeletingName(null);
    }
  }

  async function handleTest(name: string) {
    setTestingName(name);
    try {
      const result = await api.secrets.test(name);
      setTestResults((prev) => ({ ...prev, [name]: result }));
      if (result.status === "valid") {
        toast.success(`${name}: valid`);
      } else {
        toast.error(`${name}: invalid: ${result.reason}`);
      }
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Test failed");
    } finally {
      setTestingName(null);
    }
  }

  // #943 — members see a restricted notice instead of the inventory.
  if (!roleCheckPending && !isAdmin) {
    return (
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--ink-soft)]">
            Manage environment secrets for your workers. Values are write-only.
          </p>
        </header>
        <ConnectionsTabs />
        <Card className="[border:var(--bd-card)] shadow-none bg-card">
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            <KeyRound className="mx-auto mb-3 h-5 w-5 opacity-60" />
            Secret names and worker mappings are restricted to workspace owners
            and admins. Ask an admin if a worker is missing a credential.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Secrets lives under /connections/secrets (P2-9) and shares the
          Connections tabs. Same H1 ("Integrations") + subtitle pattern as
          /connections and /connections/browse so the tabs feel like one page. */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Integrations</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--ink-soft)]">
            Manage environment secrets for your workers. Values are write-only.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setAddingOpen((v) => !v)}
          className="gap-1.5"
        >
          <Plus className="w-4 h-4" />
          Add secret
        </Button>
      </header>
      <ConnectionsTabs />

      {addingOpen && (
        <Card className="[border:var(--bd-card)] shadow-none bg-card">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Add new secret</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Mobile-first: stack vertically, min h-11 (44px) touch targets */}
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <Input
                placeholder="SECRET_NAME"
                value={addingName}
                onChange={(e) => setAddingName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                className="h-11 font-mono text-sm sm:h-9 sm:w-[220px] [border:var(--bd-card)]"
              />
              <Input
                type="password"
                placeholder="Value (write-only)"
                value={addingValue}
                onChange={(e) => setAddingValue(e.target.value)}
                className="h-11 text-sm sm:h-9 sm:flex-1 [border:var(--bd-card)]"
                onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              />
              <div className="flex gap-2">
                <Button onClick={handleAdd} disabled={saving} size="sm" className="h-11 flex-1 gap-1 sm:h-9 sm:flex-none">
                  <Check className="w-4 h-4" />
                  {saving ? "Saving..." : "Save"}
                </Button>
                <Button
                  variant="ghost"
                  className="h-11 px-3 sm:h-9 sm:px-2"
                  onClick={() => { setAddingOpen(false); setAddingName(""); setAddingValue(""); }}
                >
                  <X className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* S29v (score walk): dropped Card wrapper. Matches /settings flat
          section rhythm. */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Environment secrets</h2>
        <div className="space-y-2">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)
          ) : secrets.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-3 text-center">
              <div className="w-10 h-10 rounded-[var(--radius-pill)] bg-muted flex items-center justify-center">
                <KeyRound className="w-5 h-5 text-muted-foreground" />
              </div>
              <div>
                <p className="text-sm font-medium text-foreground">No secrets configured</p>
                <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                  Workers that call external APIs require secrets. Add them here and reference them in your worker YAML.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAddingOpen(true)}
                className="mt-1 gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                Add a secret
              </Button>
            </div>
          ) : (
            secrets.map((s) => {
              const usedByExpanded = expandedUsedBy.has(s.name);
              const usedByVisible = usedByExpanded
                ? s.used_by
                : s.used_by.slice(0, USED_BY_INITIAL_COUNT);
              const usedByHidden = s.used_by.length - USED_BY_INITIAL_COUNT;

              return (
                <div key={s.name} className="space-y-2">
                  {/* min-h-[44px] ensures the row itself is a comfortable touch target */}
                  <div className="flex items-start justify-between gap-2 rounded-lg p-3 hover:bg-[var(--bg-2)] transition-colors min-h-[44px]">
                    <div className="flex items-start gap-3 min-w-0">
                      <KeyRound className="mt-0.5 w-4 h-4 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium font-mono truncate">{s.name}</p>
                        {s.used_by.length > 0 && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            <span className="opacity-70">Used by: </span>
                            {usedByVisible.map((workerName, idx) => {
                              const workerId = workersByName.get(workerName);
                              return (
                                <span key={workerName}>
                                  {idx > 0 && ", "}
                                  {workerId ? (
                                    <Link
                                      href={`/workers/${encodeURIComponent(workerId)}`}
                                      className="underline underline-offset-2 hover:text-foreground"
                                    >
                                      {workerName}
                                    </Link>
                                   ) : (
                                     workerName
                                   )}
                                </span>
                              );
                            })}
                            {!usedByExpanded && usedByHidden > 0 ? (
                              <button
                                type="button"
                                className="ml-1 inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
                                onClick={() =>
                                  setExpandedUsedBy((prev) => {
                                    const next = new Set(prev);
                                    next.add(s.name);
                                    return next;
                                  })
                                }
                              >
                                +{usedByHidden} more
                                <ChevronDown className="h-2.5 w-2.5" />
                              </button>
                            ) : usedByExpanded && s.used_by.length > USED_BY_INITIAL_COUNT ? (
                              <button
                                type="button"
                                className="ml-1 inline-flex items-center gap-0.5 underline underline-offset-2 hover:text-foreground"
                                onClick={() =>
                                  setExpandedUsedBy((prev) => {
                                    const next = new Set(prev);
                                    next.delete(s.name);
                                    return next;
                                  })
                                }
                              >
                                show less
                              </button>
                            ) : null}
                          </p>
                        )}
                        {s.last_checked_at && (
                          <p className="text-xs text-muted-foreground mt-0.5">
                            Checked {formatRelativeTime(s.last_checked_at)}
                            {s.last_check_status && (
                              <span
                                className={
                                  s.last_check_status === "valid"
                                    ? " text-[var(--positive)] font-medium"
                                    : " text-[var(--negative)] font-medium"
                                }
                              >
                                {" "}&middot; {s.last_check_status}
                              </span>
                            )}
                          </p>
                        )}
                      </div>
                    </div>
                    {/* Action buttons: min 44px touch targets on mobile via padding */}
                    <div className="flex items-center gap-1 shrink-0">
                      {testResults[s.name] && (
                        <span className="hidden sm:inline-flex" title={testResults[s.name].reason}>
                          <StatusPill
                            spec={
                              testResults[s.name].status === "valid"
                                ? { tone: "ok", label: "Valid" }
                                : { tone: "err", label: "Invalid" }
                            }
                          />
                        </span>
                      )}
                      {/* S29v: only show pill when state needs attention. */}
                      {s.status !== "set" && <StatusPill spec={{ tone: "err", label: "Missing" }} />}
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-[44px] min-w-[44px] px-2 text-xs text-muted-foreground hover:text-foreground sm:min-h-0 sm:min-w-0 sm:h-7"
                        onClick={() => handleTest(s.name)}
                        disabled={testingName === s.name}
                        title="Test this secret"
                      >
                        <TestTube2 className="w-3.5 h-3.5 sm:mr-1" />
                        <span className="hidden sm:inline">{testingName === s.name ? "Testing..." : "Test"}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-[44px] px-2 text-xs text-muted-foreground hover:text-foreground sm:min-h-0 sm:h-7"
                        onClick={() => {
                          setUpdatingName(updatingName === s.name ? null : s.name);
                          setUpdatingValue("");
                        }}
                        title="Update value"
                      >
                        <span className="hidden sm:inline">Update</span>
                        <span className="sm:hidden text-xs">Edit</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="min-h-[44px] min-w-[44px] px-2 text-xs text-[var(--negative)] hover:text-[var(--negative)] sm:min-h-0 sm:min-w-0 sm:h-7"
                        onClick={() => handleDelete(s.name)}
                        disabled={deletingName === s.name}
                        title="Remove secret"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                  {updatingName === s.name && (
                    <div className="flex flex-col gap-2 pb-2 pl-7 sm:flex-row sm:pl-10">
                      <Input
                        type="password"
                        placeholder="New value (write-only)"
                        value={updatingValue}
                        onChange={(e) => setUpdatingValue(e.target.value)}
                        className="h-11 text-sm [border:var(--bd-card)] sm:h-8 sm:flex-1"
                        onKeyDown={(e) => { if (e.key === "Enter") handleUpdate(s.name); if (e.key === "Escape") setUpdatingName(null); }}
                        autoFocus
                      />
                      <div className="flex gap-2">
                        <Button onClick={() => handleUpdate(s.name)} disabled={saving} size="sm" className="h-11 flex-1 gap-1 sm:h-8 sm:flex-none">
                          <Check className="w-3.5 h-3.5" />
                          {saving ? "..." : "Save"}
                        </Button>
                        <Button
                          variant="ghost"
                          className="h-11 px-3 sm:h-8 sm:px-2"
                          onClick={() => { setUpdatingName(null); setUpdatingValue(""); }}
                        >
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* S29v: dropped Card around the footer help text. Flat note matches
          /connections footer rhythm. */}
      <p className="text-sm text-muted-foreground">
        Secret values are write-only; they are never returned by the API. Changes to{" "}
        <code className="bg-muted px-1 py-0.5 text-xs">.env</code>{" "}
        take effect immediately without restarting workers.
      </p>
    </div>
  );
}
