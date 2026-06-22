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

function connectionLabel(status: GitWorkspaceStatus): string {
  return status.repo_full_name || (status.github_username ? `@${status.github_username}` : "GitHub");
}

function backupStatusLine(status: GitWorkspaceStatus): string {
  if (status.versioning_disabled) return "Automatic workspace backups are off.";
  if (status.last_pushed_at) return `Automatic workspace backups are on. Last backup ${formatRelative(status.last_pushed_at)}.`;
  return "Automatic workspace backups are on. First backup has not run yet.";
}

// ---------------------------------------------------------------------------
// Primary path - GitHub App install
// ---------------------------------------------------------------------------

function GitHubAppConnect({ canConnect }: { canConnect: boolean }) {
  const [connecting, setConnecting] = useState(false);

  async function handleConnect() {
    if (!canConnect || connecting) return;
    setConnecting(true);
    try {
      const result = await api.system.gitAppInstallStart();
      window.location.href = result.install_url;
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to start GitHub connection");
      setConnecting(false);
    }
  }

  return (
    <div className="space-y-4 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-card px-4 py-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-foreground">Connect GitHub</h3>
          <p className="text-sm text-muted-foreground">
            Back up your workspace to a private GitHub repo. Free.
          </p>
        </div>
        <Button onClick={() => void handleConnect()} disabled={!canConnect || connecting} className="shrink-0">
          {connecting ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-4" />}
          {connecting ? "Connecting..." : "Connect GitHub"}
        </Button>
      </div>
      {!canConnect ? (
        <p className="text-xs text-muted-foreground">
          Workspace members can view connection status. Ask a workspace admin to connect GitHub.
        </p>
      ) : null}
    </div>
  );
}

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
        Connect a GitHub token so Floom can back up your workspace (workers, contexts, and instructions) to a private repo. Every save becomes a commit. Two steps:
      </p>

      {/*
        #1118 (A4 + A5): side-by-side layout so the step-1 instructions card
        stretches to match the height of step-2 input (border extends to bottom).
        On narrow viewports both steps stack vertically (flex-col sm:flex-row).
      */}
      <div className="flex flex-col sm:flex-row gap-4 items-stretch">
        {/* Step 1 — generate a scoped token. The link pre-selects the exact
            scope (repo) and pre-fills a name, so the user lands on GitHub's
            token page with everything chosen and only has to click Generate. */}
        <div className="flex-1 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-muted/40 px-4 py-3.5 space-y-2.5">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-[var(--radius-squircle)] bg-foreground/10 text-[11px] font-semibold text-foreground">1</span>
            <div className="space-y-1.5">
              <p className="text-sm font-medium text-foreground">Create a token on GitHub</p>
              <p className="text-xs text-muted-foreground">
                The button below opens GitHub with the right scope already selected
                (<code className="font-mono text-foreground">repo</code>, for private repos).
                Pick an expiry, scroll down, and click <span className="font-medium text-foreground">Generate token</span>. Copy the value (it starts with <code className="font-mono text-foreground">ghp_</code> and is shown only once).
              </p>
              <a
                href="https://github.com/settings/tokens/new?scopes=repo&description=Floom+Workspace"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-button)] [border:var(--bd-card)] bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted"
              >
                Open GitHub token page <ExternalLink className="size-3" />
              </a>
            </div>
          </div>
        </div>

        {/* Step 2 — paste it back. Wrapped in a matching bordered card so it
            has the same visual weight as step 1 and the two cards align. */}
        <div className="flex-1 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-muted/40 px-4 py-3.5 space-y-3">
          <div className="flex items-center gap-2.5">
            <span className="grid size-5 shrink-0 place-items-center rounded-[var(--radius-squircle)] bg-foreground/10 text-[11px] font-semibold text-foreground">2</span>
            <p className="text-sm font-medium text-foreground">Paste the token here</p>
          </div>
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder="Paste ghp_… token"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void handleConnect(); }}
              className="font-mono text-sm"
              aria-label="GitHub personal access token"
            />
            <Button onClick={() => void handleConnect()} disabled={!pat.trim() || loading} className="shrink-0">
              {loading ? <Loader2 className="size-4 animate-spin" /> : "Connect"}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Your token is stored encrypted and used only to push to the repo you choose next.
          </p>
        </div>
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
        toast.success(`Linked ${fullName}: ${status.secrets_loaded} secret${status.secrets_loaded !== 1 ? "s" : ""} restored from encrypted vault`);
      } else {
        toast.success(`Linked ${fullName}: workspace pushed to GitHub`);
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
        toast.success(`Linked: ${status.secrets_loaded} secret${status.secrets_loaded !== 1 ? "s" : ""} restored from encrypted vault`);
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
            : " No workspace repos found; create one below."}
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
      toast.success("Workspace backed up");
      onPush(updated);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Backup failed");
    } finally {
      setPushing(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm("Disconnect GitHub? Floom will stop backing up this workspace to GitHub.")) return;
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
            {status.repo_url ? (
              <a
                href={status.repo_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium hover:underline flex items-center gap-1 truncate"
              >
                Connected to {connectionLabel(status)}
                <ExternalLink className="size-3 shrink-0" />
              </a>
            ) : (
              <p className="text-sm font-medium text-foreground">Connected to {connectionLabel(status)}</p>
            )}
          </div>
          <p className="text-xs text-muted-foreground pl-4">{backupStatusLine(status)}</p>
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        Floom keeps workspace changes backed up automatically. Secrets stay encrypted.
      </p>

      <details className="rounded-[var(--radius-card)] [border:var(--bd-card)] bg-muted/20 px-4 py-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Advanced</summary>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void handlePush()}
            disabled={pushing}
            className="shrink-0"
          >
            {pushing ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
            {pushing ? "Backing up..." : "Back up now"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-destructive hover:text-destructive"
            disabled={disconnecting}
            onClick={() => void handleDisconnect()}
          >
            <Unlink className="size-3.5" />
            {disconnecting ? "Disconnecting..." : "Disconnect"}
          </Button>
        </div>
      </details>
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
        GitHub is not connected for this workspace. Ask a workspace admin to connect GitHub in Settings.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 rounded-[var(--radius-card)] [border:var(--bd-card)] bg-muted/30 px-4 py-3">
        <span className="size-2 rounded-[var(--radius-pill)] bg-green-500 shrink-0" />
        <div className="min-w-0">
          {status.repo_url ? (
            <a
              href={status.repo_url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium hover:underline flex items-center gap-1 truncate"
            >
              Connected to {connectionLabel(status)}
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : (
            <p className="text-sm font-medium text-foreground">Connected to {connectionLabel(status)}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {backupStatusLine(status)}
          </p>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        Automatic workspace backups are managed by a workspace admin.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

type Step = "loading" | "connect" | "repos" | "connected";

export function GitWorkspacePanel({ canManageWorkspace }: { canManageWorkspace: boolean }) {
  const [step, setStep] = useState<Step>("loading");
  const [status, setStatus] = useState<GitWorkspaceStatus | null>(null);
  const [username, setUsername] = useState<string>("");

  useEffect(() => {
    api.system.gitStatus().catch(() => null).then((s) => {
      if (s?.connected) {
        setStatus(s);
        setStep("connected");
      } else {
        setStatus(s);
        setStep("connect");
      }
    });
  }, []);

  // Still loading
  if (step === "loading") {
    return (
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <ExternalLink className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">GitHub</h2>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      </section>
    );
  }

  // Members get a read-only view — no config controls
  if (!canManageWorkspace) {
    return (
      <section className="space-y-4">
        <div className="flex items-center gap-2">
          <ExternalLink className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">GitHub</h2>
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
        <ExternalLink className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">GitHub</h2>
        {step === "connected" && (
          <span className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-green-500/10 px-2 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400">
            <Check className="size-2.5" /> Connected
          </span>
        )}
      </div>

      {step === "connect" && (
        <>
          <GitHubAppConnect canConnect={canManageWorkspace} />
          <details className="rounded-[var(--radius-card)] [border:var(--bd-card)] bg-muted/20 px-4 py-3">
            <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
              Advanced: use a token instead
            </summary>
            <div className="mt-4">
              <PATForm
                onConnected={(u) => {
                  setUsername(u);
                  setStep("repos");
                }}
              />
            </div>
          </details>
        </>
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
            setStep("connect");
          }}
        />
      )}
    </section>
  );
}
