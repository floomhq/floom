"use client";

import { useQuery, useMutation, useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState } from "react";
import { Copy, Check, Eye, EyeOff, Pencil, MinusCircle, Undo2 } from "lucide-react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

export default function SecretsPage() {
  const convex = useConvex();
  const secrets = useQuery(api.secrets.list);
  const upsert = useMutation(api.secrets.upsert);
  const remove = useMutation(api.secrets.remove);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Per-secret UI state
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const [decryptedValues, setDecryptedValues] = useState<Record<string, string>>({});
  const [editingSecret, setEditingSecret] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editValue, setEditValue] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function fetchDecryptedValue(secretName: string): Promise<string | null> {
    if (decryptedValues[secretName]) return decryptedValues[secretName];
    try {
      const value = await convex.query(api.secrets.getDecryptedValue, { name: secretName });
      setDecryptedValues((prev) => ({ ...prev, [secretName]: value }));
      return value;
    } catch {
      return null;
    }
  }

  async function toggleVisibility(secretName: string) {
    if (visibleSecrets.has(secretName)) {
      setVisibleSecrets((prev) => {
        const next = new Set(prev);
        next.delete(secretName);
        return next;
      });
    } else {
      await fetchDecryptedValue(secretName);
      setVisibleSecrets((prev) => new Set(prev).add(secretName));
    }
  }

  async function handleCopy(secretName: string) {
    const val = await fetchDecryptedValue(secretName);
    if (!val) return;
    await navigator.clipboard.writeText(val);
    setCopiedSecret(secretName);
    setTimeout(() => setCopiedSecret(null), 2000);
  }

  async function startEdit(secretName: string) {
    const val = await fetchDecryptedValue(secretName);
    setEditingSecret(secretName);
    setEditName(secretName);
    setEditValue(val ?? "");
  }

  function cancelEdit() {
    setEditingSecret(null);
    setEditName("");
    setEditValue("");
  }

  async function saveEdit() {
    if (!editName.trim() || !editValue.trim() || !editingSecret) return;
    setEditSaving(true);
    try {
      // If name changed, remove old and create new
      if (editName.trim() !== editingSecret) {
        await remove({ name: editingSecret });
      }
      await upsert({ name: editName.trim().toUpperCase(), value: editValue.trim() });
      // Update cached decrypted value
      setDecryptedValues((prev) => {
        const next = { ...prev };
        delete next[editingSecret!];
        next[editName.trim().toUpperCase()] = editValue.trim();
        return next;
      });
      setEditingSecret(null);
      setEditName("");
      setEditValue("");
    } catch {
      // keep editing open on error
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDelete(secretName: string) {
    setConfirmDelete(null);
    await remove({ name: secretName });
    setDecryptedValues((prev) => {
      const next = { ...prev };
      delete next[secretName];
      return next;
    });
    setVisibleSecrets((prev) => {
      const next = new Set(prev);
      next.delete(secretName);
      return next;
    });
  }

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !value.trim()) return;
    setSaving(true);
    setSaveError("");
    try {
      await upsert({ name: name.trim().toUpperCase(), value: value.trim() });
      setName("");
      setValue("");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Workspace Secrets</CardTitle>
            <CardDescription>
              View and configure environment variables for your workspace.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* Loading state */}
            {secrets === undefined && (
              <div className="space-y-2">
                {[1, 2].map((i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            )}

            {/* Empty state */}
            {secrets !== undefined && secrets.length === 0 && (
              <p className="text-sm text-muted-foreground">No secrets saved yet.</p>
            )}

            {/* Secrets table */}
            {secrets !== undefined && secrets.length > 0 && (
              <Table className="table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[200px]">Name</TableHead>
                    <TableHead>Value</TableHead>
                    <TableHead className="w-28">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {secrets.map((secret: { name: string }) => (
                    <TableRow key={secret.name}>
                      {editingSecret === secret.name ? (
                        <>
                          <TableCell>
                            <Input
                              type="text"
                              value={editName}
                              onChange={(e) => setEditName(e.target.value.toUpperCase())}
                              className="font-mono"
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              type="text"
                              value={editValue}
                              onChange={(e) => setEditValue(e.target.value)}
                            />
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button
                                size="sm"
                                onClick={saveEdit}
                                disabled={editSaving || !editName.trim() || !editValue.trim()}
                              >
                                {editSaving ? "Saving..." : "Save"}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={cancelEdit}
                              >
                                <Undo2 className="size-3" />
                                Cancel
                              </Button>
                            </div>
                          </TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell>
                            <span className="font-mono font-medium">
                              {secret.name}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-start gap-2 min-w-0 overflow-hidden">
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      onClick={() => toggleVisibility(secret.name)}
                                    />
                                  }
                                >
                                  {visibleSecrets.has(secret.name) ? (
                                    <EyeOff className="size-3.5" />
                                  ) : (
                                    <Eye className="size-3.5" />
                                  )}
                                </TooltipTrigger>
                                <TooltipContent>
                                  {visibleSecrets.has(secret.name) ? "Hide value" : "Show value"}
                                </TooltipContent>
                              </Tooltip>
                              {visibleSecrets.has(secret.name) && decryptedValues[secret.name] ? (
                                <span className="text-sm font-mono min-w-0 break-all whitespace-pre-wrap">
                                  {decryptedValues[secret.name]}
                                </span>
                              ) : (
                                <Badge variant="secondary" className="font-mono">
                                  {"••••••••••••••"}
                                </Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      onClick={() => startEdit(secret.name)}
                                    />
                                  }
                                >
                                  <Pencil className="size-3.5" />
                                </TooltipTrigger>
                                <TooltipContent>Edit</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      onClick={() => handleCopy(secret.name)}
                                    />
                                  }
                                >
                                  {copiedSecret === secret.name ? (
                                    <Check className="size-3.5 text-emerald-500" />
                                  ) : (
                                    <Copy className="size-3.5" />
                                  )}
                                </TooltipTrigger>
                                <TooltipContent>Copy value</TooltipContent>
                              </Tooltip>
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <Button
                                      variant="ghost"
                                      size="icon-xs"
                                      onClick={() => setConfirmDelete(secret.name)}
                                    />
                                  }
                                >
                                  <MinusCircle className="size-3.5" />
                                </TooltipTrigger>
                                <TooltipContent>Delete</TooltipContent>
                              </Tooltip>
                            </div>
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        {/* Add secret form */}
        <Card>
          <CardHeader>
            <CardTitle>Add secret</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAdd} className="space-y-3">
              <div className="flex items-end gap-2">
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="secret-name">Name</Label>
                  <Input
                    id="secret-name"
                    type="text"
                    placeholder="e.g. ANTHROPIC_API_KEY"
                    value={name}
                    onChange={(e) => setName(e.target.value.toUpperCase())}
                    className="font-mono"
                  />
                </div>
                <div className="flex-1 space-y-1.5">
                  <Label htmlFor="secret-value">Value</Label>
                  <Input
                    id="secret-value"
                    type="password"
                    placeholder="Value"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                </div>
                <Button
                  type="submit"
                  disabled={saving || !name.trim() || !value.trim()}
                >
                  {saving ? "Saving..." : "Add"}
                </Button>
              </div>
              {saveError && (
                <p className="text-sm text-destructive">{saveError}</p>
              )}
            </form>
          </CardContent>
        </Card>

        {/* Delete confirmation dialog */}
        <Dialog open={!!confirmDelete} onOpenChange={(open) => !open && setConfirmDelete(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete secret</DialogTitle>
              <DialogDescription>
                Are you sure you want to delete{" "}
                <code className="font-mono bg-muted px-1 py-0.5 rounded text-xs">
                  {confirmDelete}
                </code>
                ? This action cannot be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose
                className={cn(buttonVariants({ variant: "outline" }))}
              >
                Cancel
              </DialogClose>
              <Button
                variant="destructive"
                onClick={() => confirmDelete && handleDelete(confirmDelete)}
              >
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </TooltipProvider>
  );
}
