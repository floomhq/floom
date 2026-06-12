"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, ExternalLink, GitBranch, Loader2, Plus, RefreshCw, Unlink } from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { GitRepoItem, GitWorkspaceStatus } from "@/lib/types";
import { formatRelative } from "@/lib/formatters";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Step 1 — enter PAT
// ---------------------------------------------------------------------------

function PATForm({ onConnected }: { onConnected: (username: string) => void }) {
  const [pat, setPat] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleConnect() {
    if (!pat.trim()) return;
    setLoading(true);
    try {
      const result = await api.system.gitConnect(pat.trim());
      toast.success(`Connected as @${result.username}`);
      onConnected(result.username);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to connect");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Connect a GitHub Personal Access Token so Floom can push your workspace — workers, contexts, and instructions — to a private repo. Every save becomes a commit.
      </p>

      <div className="rounded-[var(--radius-card)] [border:var(--bd-card)] bg-muted/40 px-4 py-3 space-y-1">
        <p className="text-xs font-medium text-muted-foreground">Required PAT scope</p>
        <code className="text-xs text-foreground">repo</code>
        <p className="text-xs text-muted-foreground">
          (needed to create and push to private repos)
        </p>
      </div>

      <a
        href="https://github.com/settings/tokens/new?scopes=repo&description=Floom+Workspace"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
      >
        Create a token on GitHub <ExternalLink className="size-3" />
      </a>

      <div className="flex gap-2">
        <Input
          type="password"
          placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
          value={pat}
          onChange={(e) => setPat(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void handleConnect(); }}
          className="font-mono text-sm"
        />
        <Button onClick={() => void handleConnect()} disabled={!pat.trim() || loading} className="shrink-0">
          {loading ? <Loader2 className="size-4 animate-spin" /> : "Connect"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — pick or create a repo
// ---------------------------------------------------------------------------

function RepoSelector({
  username,
  onLinked,
}: {
  username: string;
  onLinked: (status: GitWorkspaceStatus) => void;
}) {
  const [repos, setRepos] = useState<GitRepoItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [linking, setLinking] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  const loadRepos = useCallback(async () => {
    setLoading(true);
    try {
      const list = await api.system.gitListRepos();
      setRepos(list);
      if (list.length === 0) setShowCreate(true);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load repos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void loadRepos(); }, [loadRepos]);

  async function handleLink(fullName: string) {
    setLinking(fullName);
    try {
      const status = await api.system.gitLink(fullName);
      if (status.secrets_loaded && status.secrets_loaded > 0) {
        toast.success(`Linked ${fullName} — ${status.secrets_loaded} secret${status.secrets_loaded !== 1 ? "s" : ""} restored from encrypted vault`);
      } else {
        toast.success(`Linked ${fullName} — workspace pushed to GitHub`);
      }
      onLinked(status);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to link repo");
    } finally {
      setLinking(null);
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const repo = await api.system.gitCreateRepo(newName.trim());
      toast.success(`Created ${repo.full_name}`);
      const status = await api.system.gitLink(repo.full_name);
      if (status.secrets_loaded && status.secrets_loaded > 0) {
        toast.success(`Linked — ${status.secrets_loaded} secret${status.secrets_loaded !== 1 ? "s" : ""} restored from encrypted vault`);
      } else {
        toast.success("Workspace pushed to GitHub");
      }
      onLinked(status);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to create repo");
      setCreating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Connected as <span className="font-medium text-foreground">@{username}</span>.
          {repos.length > 0
            ? " Pick an existing workspace repo or create a new one."
            : " No workspace repos found — create one below."}
        </p>
        <Button variant="ghost" size="sm" onClick={() => void loadRepos()} disabled={loading}>
          <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4">
          <Loader2 className="size-4 animate-spin" /> Loading repos…
        </div>
      ) : (
        <div className="[&>*+*]:[border-top:var(--bd-div)] rounded-[var(--radius-card)] [border:var(--bd-card)] overflow-hidden">
          {repos.map((r) => (
            <div key={r.full_name} className="flex items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-sm font-medium truncate">{r.full_name}</span>
                  <span className="text-[10px] text-muted-foreground [border:var(--bd-card)] rounded px-1 py-0.5 shrink-0">
                    {r.private ? "private" : "public"}
                  </span>
                </div>
                {r.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate pl-5">{r.description}</p>
                )}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="shrink-0"
                disabled={linking === r.full_name}
                onClick={() => void handleLink(r.full_name)}
              >
                {linking === r.full_name ? <Loader2 className="size-3.5 animate-spin" /> : "Link"}
              </Button>
            </div>
          ))}

          {/* Create new */}
          {showCreate ? (
            <div className="px-4 py-3 space-y-2">
              <p className="text-xs text-muted-foreground">New private repo name</p>
              <div className="flex gap-2 items-center">
                <span className="text-xs text-muted-foreground shrink-0 font-mono">workeros-</span>
                <Input
                  className="text-sm h-8"
                  placeholder="my-company"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") void handleCreate(); }}
                />
                <Button size="sm" disabled={!newName.trim() || creating} onClick={() => void handleCreate()} className="shrink-0">
                  {creating ? <Loader2 className="size-3.5 animate-spin" /> : "Create"}
                </Button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setShowCreate(true)}
              className="w-full flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground hover:bg-muted/50 transition-colors"
            >
              <Plus className="size-4" /> Create new workspace repo
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — connected status
// ---------------------------------------------------------------------------

function ConnectedView({
  status,
  onPush,
  onDisconnect,
}: {
  status: GitWorkspaceStatus;
  onPush: (s: GitWorkspaceStatus) => void;
  onDisconnect: () => void;
}) {
  const [pushing, setPushing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  async function handlePush() {
    setPushing(true);
    try {
      const updated = await api.system.gitPush();
      toast.success("Workspace pushed to GitHub");
      onPush(updated);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Push failed");
    } finally {
      setPushing(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Disconnect GitHub? The local git history is kept, but Floom will stop pushing to GitHub.")) return;
    setDisconnecting(true);
    try {
      await api.system.gitDisconnect();
      toast.success("Disconnected from GitHub");
      onDisconnect();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to disconnect");
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-muted/30 px-4 py-3">
        <div className="space-y-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="size-2 rounded-[var(--radius-pill)] bg-green-500 shrink-0" />
            <a
              href={status.repo_url ?? "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium hover:underline flex items-center gap-1 truncate"
            >
              {status.repo_full_name}
              <ExternalLink className="size-3 shrink-0" />
            </a>
          </div>
          {status.github_username && (
            <p className="text-xs text-muted-foreground pl-4">@{status.github_username}</p>
          )}
          <p className="text-xs text-muted-foreground pl-4">
            {status.last_pushed_at
              ? <>Last pushed {formatRelative(status.last_pushed_at)}</>
              : "Never pushed"}
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void handlePush()}
          disabled={pushing}
          className="shrink-0"
        >
          {pushing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          {pushing ? "Pushing…" : "Push now"}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Every worker save, context edit, and workspace update is automatically committed and pushed to this repo. Secrets are encrypted and stored in the repo — a fresh install with the same GitHub connection restores them automatically.
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          disabled={disconnecting}
          onClick={() => void handleDisconnect()}
        >
          <Unlink className="size-3.5" />
          {disconnecting ? "Disconnecting…" : "Disconnect"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Member read-only view
// ---------------------------------------------------------------------------

function MemberView({ status }: { status: GitWorkspaceStatus | null }) {
  if (!status?.connected) {
    return (
      <p className="text-sm text-muted-foreground">
        GitHub is not configured for this workspace. Ask a workspace admin to connect a GitHub repo in Settings → GitHub.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-muted/30 px-4 py-3">
        <span className="size-2 rounded-[var(--radius-pill)] bg-green-500 shrink-0" />
        <div className="min-w-0">
          <a
            href={status.repo_url ?? "#"}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium hover:underline flex items-center gap-1 truncate"
          >
            {status.repo_full_name}
            <ExternalLink className="size-3 shrink-0" />
          </a>
          <p className="text-xs text-muted-foreground">
            {status.last_pushed_at
              ? <>Last pushed {formatRelative(status.last_pushed_at)}</>
              : "Never pushed"}
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Every save you make is automatically committed and pushed to this repo. Contact a workspace admin to change the configuration.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

type Step = "loading" | "pat" | "repos" | "connected";

export function GitWorkspacePanel() {
  const [step, setStep] = useState<Step>("loading");
  const [status, setStatus] = useState<GitWorkspaceStatus | null>(null);
  const [username, setUsername] = useState<string>("");
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  useEffect(() => {
    Promise.all([
      api.system.gitStatus().catch(() => null),
      api.me().catch(() => null),
    ]).then(([s, me]) => {
      // role === "admin" or unset (dev mode / OSS single-user) = admin access
      const admin = !me || !me.role || me.role === "admin";
      setIsAdmin(admin);
      if (s?.connected) {
        setStatus(s);
        setStep("connected");
      } else {
        setStep("pat");
      }
    });
  }, []);

  // Still loading
  if (isAdmin === null) {
    return (
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">GitHub workspace</h2>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      </section>
    );
  }

  // Members get a read-only view — no config controls
  if (!isAdmin) {
    return (
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <GitBranch className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">GitHub workspace</h2>
          {status?.connected && (
            <span className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
              <Check className="size-2.5" /> Connected
            </span>
          )}
        </div>
        <MemberView status={status} />
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex items-center gap-2">
        <GitBranch className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">GitHub workspace</h2>
        {step === "connected" && (
          <span className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
            <Check className="size-2.5" /> Connected
          </span>
        )}
      </div>

      {step === "loading" && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      )}

      {step === "pat" && (
        <PATForm
          onConnected={(u) => {
            setUsername(u);
            setStep("repos");
          }}
        />
      )}

      {step === "repos" && (
        <RepoSelector
          username={username}
          onLinked={(s) => {
            setStatus(s);
            setStep("connected");
          }}
        />
      )}

      {step === "connected" && status && (
        <ConnectedView
          status={status}
          onPush={(s) => setStatus(s)}
          onDisconnect={() => {
            setStatus(null);
            setStep("pat");
          }}
        />
      )}
    </section>
  );
}
