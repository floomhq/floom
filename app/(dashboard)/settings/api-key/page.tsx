"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState, useEffect } from "react";
import { Copy, Check, Key, Terminal, Plus, Ban } from "lucide-react";
import { Id } from "@/convex/_generated/dataModel";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "@/components/ui/tooltip";

export default function ApiKeyPage() {
  const [copiedInstall, setCopiedInstall] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [copiedNewKey, setCopiedNewKey] = useState(false);
  const [keyName, setKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [orgId, setOrgId] = useState<Id<"organizations"> | null>(null);

  const createKey = useMutation(api.apiKeys.create);
  const revokeKey = useMutation(api.apiKeys.revoke);
  const keys = useQuery(api.apiKeys.list, orgId ? { orgId } : "skip");

  // Get orgId from the user upsert on mount
  const upsertUser = useMutation(api.users.upsert);
  useEffect(() => {
    upsertUser({ email: "" })
      .then((result) => {
        if (result?.orgId) setOrgId(result.orgId);
      })
      .catch(() => {});
  }, [upsertUser]);

  const [origin, setOrigin] = useState("https://dashboard.floom.dev");
  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const installCommand = `curl -s ${origin}/install-skill.sh | bash -s -- ${origin}`;

  async function copyInstall() {
    await navigator.clipboard.writeText(installCommand);
    setCopiedInstall(true);
    setTimeout(() => setCopiedInstall(false), 2000);
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!orgId || !keyName.trim()) return;
    setCreating(true);
    try {
      const rawKey = await createKey({ orgId, name: keyName.trim() });
      setNewKeyValue(rawKey);
      setKeyName("");
    } catch (err) {
      console.error(err);
    } finally {
      setCreating(false);
    }
  }

  async function copyNewKey() {
    if (!newKeyValue) return;
    await navigator.clipboard.writeText(newKeyValue);
    setCopiedNewKey(true);
    setTimeout(() => setCopiedNewKey(false), 2000);
  }

  return (
    <TooltipProvider>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>API Keys</CardTitle>
            <CardDescription>
              Org-scoped keys to authenticate the{" "}
              <code className="font-mono bg-muted px-1 py-0.5 rounded text-xs">
                floom
              </code>{" "}
              Claude Code skill.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* New key banner */}
            {newKeyValue && (
              <Alert>
                <Key className="size-4" />
                <AlertTitle>
                  New API key created. Copy it now -- it will not be shown again.
                </AlertTitle>
                <AlertDescription>
                  <div className="flex items-center gap-2 mt-2">
                    <code className="flex-1 text-xs font-mono bg-muted px-2 py-1 rounded truncate">
                      {newKeyValue}
                    </code>
                    <Button variant="outline" size="sm" onClick={copyNewKey}>
                      {copiedNewKey ? (
                        <Check className="size-3 text-emerald-500" />
                      ) : (
                        <Copy className="size-3" />
                      )}
                      {copiedNewKey ? "Copied!" : "Copy"}
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}

            {/* Existing keys list */}
            {keys && keys.length > 0 && (
              <div className="divide-y divide-border rounded-lg border">
                {keys.map((k) => (
                  <div
                    key={k._id}
                    className="flex items-center justify-between px-3 py-2.5"
                  >
                    <div className="flex items-center gap-3">
                      <Key className="size-3.5 text-muted-foreground" />
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">
                          {k.name}
                        </span>
                        <span className="text-xs text-muted-foreground font-mono">
                          {k.prefix}...
                        </span>
                        {k.revokedAt && (
                          <Badge variant="destructive">Revoked</Badge>
                        )}
                      </div>
                    </div>
                    {!k.revokedAt && (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => revokeKey({ keyId: k._id })}
                            />
                          }
                        >
                          <Ban className="size-3.5 text-muted-foreground hover:text-destructive" />
                        </TooltipTrigger>
                        <TooltipContent>Revoke key</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Create key form */}
            <form onSubmit={handleCreate} className="flex items-center gap-2">
              <Input
                type="text"
                placeholder="Key name (e.g. dev-laptop)"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                className="flex-1"
              />
              <Button
                type="submit"
                disabled={creating || !keyName.trim() || !orgId}
              >
                <Plus className="size-3.5" />
                {creating ? "Creating..." : "Create key"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Separator />

        <Card>
          <CardHeader>
            <CardTitle>Install Skill</CardTitle>
            <CardDescription>
              Run this in your terminal to install floom in Claude Code:
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-2">
              <div className="flex-1 flex items-center gap-2 rounded-lg border bg-muted/50 px-3 py-2">
                <Terminal className="size-3.5 text-muted-foreground shrink-0" />
                <code className="text-xs font-mono text-foreground truncate">
                  {installCommand}
                </code>
              </div>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="outline" onClick={copyInstall} />
                  }
                >
                  {copiedInstall ? (
                    <Check className="size-3.5 text-emerald-500" />
                  ) : (
                    <Copy className="size-3.5" />
                  )}
                  {copiedInstall ? "Copied!" : "Copy"}
                </TooltipTrigger>
                <TooltipContent>Copy install command</TooltipContent>
              </Tooltip>
            </div>
          </CardContent>
        </Card>
      </div>
    </TooltipProvider>
  );
}
