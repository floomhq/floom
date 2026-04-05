"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState } from "react";
import { Trash2, Plus, ShieldCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

export function SecretsTab() {
  const secrets = useQuery(api.secrets.list);
  const upsert = useMutation(api.secrets.upsert);
  const remove = useMutation(api.secrets.remove);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !value.trim()) return;
    setStatus("saving");
    try {
      await upsert({ name: name.trim().toUpperCase(), value: value.trim() });
      setName("");
      setValue(""); // clear value immediately — never display it again
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("idle");
    }
  };

  const handleDelete = async (secretName: string) => {
    await remove({ name: secretName });
    setDeleteConfirm(null);
  };

  return (
    <div className="p-4 max-w-lg">
      <div className="flex items-center gap-2 mb-4">
        <ShieldCheck className="size-4 text-muted-foreground" />
        <h3 className="text-sm font-medium text-foreground">Org Secrets</h3>
      </div>

      <Alert className="mb-4">
        <AlertDescription>
          Secrets are encrypted and shared across all automations in your org.
          Values are never visible after saving.
        </AlertDescription>
      </Alert>

      {/* Add secret form */}
      <Card className="mb-4">
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div className="space-y-1.5">
              <Label>
                Name{" "}
                <span className="text-muted-foreground font-normal">
                  (e.g. ANTHROPIC_API_KEY)
                </span>
              </Label>
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="SECRET_NAME"
                className="font-mono"
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label>Value</Label>
              <Input
                type="password"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
                required
              />
            </div>
            <Button
              type="submit"
              size="sm"
              disabled={status === "saving" || !name.trim() || !value.trim()}
            >
              <Plus className="size-3.5" />
              {status === "saving"
                ? "Saving..."
                : status === "saved"
                  ? "Saved!"
                  : "Save Secret"}
            </Button>
          </form>
        </CardContent>
      </Card>

      {/* Secret list */}
      {secrets === undefined ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : secrets.length === 0 ? (
        <p className="text-xs text-muted-foreground">No secrets stored yet.</p>
      ) : (
        <ul className="space-y-1">
          {secrets.map((s: { name: string }) => (
            <li
              key={s.name}
              className="flex items-center justify-between px-3 py-2 rounded-lg border text-sm"
            >
              <div className="flex items-center gap-3">
                <span className="font-mono text-foreground text-xs">
                  {s.name}
                </span>
                <Badge variant="secondary">
                  \u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022
                </Badge>
              </div>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => setDeleteConfirm(s.name)}
              >
                <Trash2 className="size-3.5 text-muted-foreground" />
              </Button>
            </li>
          ))}
        </ul>
      )}

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteConfirm !== null}
        onOpenChange={(open) => !open && setDeleteConfirm(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete secret</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete{" "}
              <span className="font-medium text-foreground font-mono">
                {deleteConfirm}
              </span>
              ? Automations using this secret will fail until it is re-added.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && handleDelete(deleteConfirm)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
