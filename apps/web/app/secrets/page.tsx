"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { KeyRound, TestTube2, Trash2, Plus, Check, X } from "lucide-react";
import { toast } from "sonner";
import type { SecretItem } from "@/lib/types";
import { formatRelativeTime } from "@/components/connections/connection-data";

export default function SecretsPage() {
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [addingName, setAddingName] = useState("");
  const [addingValue, setAddingValue] = useState("");
  const [addingOpen, setAddingOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testingName, setTestingName] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<Record<string, { status: string; reason?: string }>>({});
  const [updatingName, setUpdatingName] = useState<string | null>(null);
  const [updatingValue, setUpdatingValue] = useState("");
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const s = await api.secrets.list();
      setSecrets(s);
    } catch {
      toast.error("Failed to load secrets");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Secrets</h1>
          <p className="text-[#666] text-sm mt-1">Manage environment secrets for your workers. Values are write-only.</p>
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
      </div>

      {addingOpen && (
        <Card className="border-[#eaeaea] shadow-none bg-white">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Add new secret</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-3 flex-wrap">
              <Input
                placeholder="SECRET_NAME"
                value={addingName}
                onChange={(e) => setAddingName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, "_"))}
                className="font-mono text-sm w-[220px] border-[#e4e4e7]"
              />
              <Input
                type="password"
                placeholder="Value (write-only)"
                value={addingValue}
                onChange={(e) => setAddingValue(e.target.value)}
                className="text-sm flex-1 border-[#e4e4e7]"
                onKeyDown={(e) => { if (e.key === "Enter") handleAdd(); }}
              />
              <Button onClick={handleAdd} disabled={saving} size="sm" className="gap-1">
                <Check className="w-4 h-4" />
                {saving ? "Saving..." : "Save"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => { setAddingOpen(false); setAddingName(""); setAddingValue(""); }}
              >
                <X className="w-4 h-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardHeader>
          <CardTitle className="text-sm font-medium">Environment secrets</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)
          ) : secrets.length === 0 ? (
            <p className="text-sm text-[#999]">No secrets configured. Add one above.</p>
          ) : (
            secrets.map((s) => (
              <div key={s.name} className="space-y-2">
                <div className="flex items-center justify-between p-3 rounded-md hover:bg-[#f4f4f5] transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <KeyRound className="w-4 h-4 text-[#999] shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium font-mono">{s.name}</p>
                      {s.used_by.length > 0 && (
                        <p className="text-xs text-[#999]">Used by: {s.used_by.join(", ")}</p>
                      )}
                      {s.last_checked_at && (
                        <p className="text-xs text-[#999]">
                          Checked {formatRelativeTime(s.last_checked_at)}
                          {s.last_check_status && (
                            <span
                              className={
                                s.last_check_status === "valid"
                                  ? " text-emerald-600 font-medium"
                                  : " text-red-500 font-medium"
                              }
                            >
                              {" "}&middot; {s.last_check_status}
                            </span>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {testResults[s.name] && (
                      <Badge
                        variant="outline"
                        className={
                          testResults[s.name].status === "valid"
                            ? "text-emerald-600 border-emerald-200 bg-emerald-50 text-xs"
                            : "text-red-600 border-red-200 bg-red-50 text-xs"
                        }
                        title={testResults[s.name].reason}
                      >
                        {testResults[s.name].status === "valid" ? "Valid" : "Invalid"}
                      </Badge>
                    )}
                    <Badge
                      variant="outline"
                      className={
                        s.status === "set"
                          ? "text-emerald-600 border-emerald-200 bg-emerald-50"
                          : "text-red-600 border-red-200 bg-red-50"
                      }
                    >
                      {s.status === "set" ? "Set" : "Missing"}
                    </Badge>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-[#666] hover:text-[#333]"
                      onClick={() => handleTest(s.name)}
                      disabled={testingName === s.name}
                      title="Test this secret"
                    >
                      <TestTube2 className="w-3.5 h-3.5 mr-1" />
                      {testingName === s.name ? "Testing..." : "Test"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-[#666] hover:text-[#333]"
                      onClick={() => {
                        setUpdatingName(updatingName === s.name ? null : s.name);
                        setUpdatingValue("");
                      }}
                      title="Update value"
                    >
                      Update
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 px-2 text-xs text-red-500 hover:text-red-700"
                      onClick={() => handleDelete(s.name)}
                      disabled={deletingName === s.name}
                      title="Remove secret"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                </div>
                {updatingName === s.name && (
                  <div className="flex gap-2 pl-10 pb-2">
                    <Input
                      type="password"
                      placeholder="New value (write-only)"
                      value={updatingValue}
                      onChange={(e) => setUpdatingValue(e.target.value)}
                      className="text-sm flex-1 border-[#e4e4e7] h-8"
                      onKeyDown={(e) => { if (e.key === "Enter") handleUpdate(s.name); if (e.key === "Escape") setUpdatingName(null); }}
                      autoFocus
                    />
                    <Button onClick={() => handleUpdate(s.name)} disabled={saving} size="sm" className="h-8 gap-1">
                      <Check className="w-3.5 h-3.5" />
                      {saving ? "..." : "Save"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-8"
                      onClick={() => { setUpdatingName(null); setUpdatingValue(""); }}
                    >
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card className="border-[#eaeaea] shadow-none bg-white">
        <CardContent className="p-5 text-sm text-[#666]">
          <p>
            Secret values are write-only; they are never returned by the API. Changes to{" "}
            <code className="bg-[#f4f4f5] px-1 py-0.5 rounded text-xs">.env</code>{" "}
            take effect immediately without restarting workers.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
