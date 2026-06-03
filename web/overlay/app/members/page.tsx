"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Users,
  UserPlus,
  MoreVertical,
  Mail,
  ShieldCheck,
  Clock,
  Check,
  X,
} from "lucide-react";
import { toast } from "sonner";

const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE ?? "/api/proxy";
const WS_KEY = "workeros.activeWorkspaceId";

function wsId(): string | null {
  if (typeof window === "undefined") return null;
  const v = window.localStorage.getItem(WS_KEY);
  return v && v !== "local-default" ? v : null;
}

function wsHeaders(init?: HeadersInit): Headers {
  const h = new Headers(init);
  const id = wsId();
  if (id) h.set("x-workeros-workspace", id);
  if (!h.has("Content-Type")) h.set("Content-Type", "application/json");
  return h;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: wsHeaders(options?.headers),
  });
  if (!res.ok) {
    let msg = "";
    try { const b = await res.json(); msg = b.detail ?? JSON.stringify(b); } catch { msg = ""; }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  if (res.status === 204) return null as T;
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

type Member = { id: string; user_id: string; role: string; joined_at: string | null };
type Invitation = { id: string; email: string; role: string; status: string; created_at: string; expires_at: string | null };

// ---------------------------------------------------------------------------
// page shell
// ---------------------------------------------------------------------------

export default function MembersPage() {
  return <MembersContent />;
}

// ---------------------------------------------------------------------------
// loading skeleton — same pattern as secrets page
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div className="space-y-1.5">
          <Skeleton className="h-7 w-32 rounded" />
          <Skeleton className="h-4 w-64 rounded" />
        </div>
        <Skeleton className="h-8 w-28 rounded" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-4 w-24 rounded" />
        {[1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-14 w-full rounded-lg" />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// main component
// ---------------------------------------------------------------------------

function MembersContent() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);

  // invite form state (collapsible, like the secrets "add" form)
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteSaving, setInviteSaving] = useState(false);

  // per-row busy state
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [roleChangingId, setRoleChangingId] = useState<string | null>(null);

  useEffect(() => {
    const ws = wsId();
    setWorkspaceId(ws);
    if (ws) void refresh(ws);
    else setLoading(false);
  }, []);

  const refresh = useCallback(async (ws: string) => {
    try {
      const [mRes, iRes] = await Promise.all([
        apiFetch<{ members: Member[] }>(`/workspaces/${ws}/members`),
        apiFetch<{ invitations: Invitation[] }>(`/workspaces/${ws}/invitations`),
      ]);
      setMembers(mRes.members ?? []);
      setInvitations(iRes.invitations ?? []);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to load members");
    } finally {
      setLoading(false);
    }
  }, []);

  // ---- invite ---------------------------------------------------------------

  async function handleInvite() {
    if (!workspaceId) return;
    if (!inviteEmail.trim()) { toast.error("Email is required"); return; }
    setInviteSaving(true);
    try {
      await apiFetch(`/workspaces/${workspaceId}/members/invite`, {
        method: "POST",
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      toast.success(`Invite sent to ${inviteEmail.trim()}`);
      setInviteEmail("");
      setInviteRole("member");
      setInviteOpen(false);
      void refresh(workspaceId);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to send invite");
    } finally {
      setInviteSaving(false);
    }
  }

  // ---- role change ----------------------------------------------------------

  async function handleRoleChange(userId: string, newRole: string) {
    if (!workspaceId) return;
    setRoleChangingId(userId);
    try {
      await apiFetch(`/workspaces/${workspaceId}/members/${userId}/role`, {
        method: "PATCH",
        body: JSON.stringify({ role: newRole }),
      });
      toast.success("Role updated");
      void refresh(workspaceId);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to update role");
    } finally {
      setRoleChangingId(null);
    }
  }

  // ---- remove member --------------------------------------------------------

  async function handleRemove(userId: string) {
    if (!workspaceId) return;
    setRemovingId(userId);
    try {
      await apiFetch(`/workspaces/${workspaceId}/members/${userId}`, { method: "DELETE" });
      toast.success("Member removed");
      void refresh(workspaceId);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to remove member");
    } finally {
      setRemovingId(null);
    }
  }

  // ---- revoke invite --------------------------------------------------------

  async function handleRevoke(invId: string) {
    if (!workspaceId) return;
    setRevokingId(invId);
    try {
      await apiFetch(`/workspaces/${workspaceId}/invitations/${invId}`, { method: "DELETE" });
      toast.success("Invitation revoked");
      void refresh(workspaceId);
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to revoke invitation");
    } finally {
      setRevokingId(null);
    }
  }

  // ---- render ---------------------------------------------------------------

  if (loading) return <LoadingSkeleton />;

  if (!workspaceId) {
    return (
      <div className="py-12 flex flex-col items-center gap-3 text-center">
        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
          <Users className="w-5 h-5 text-muted-foreground" />
        </div>
        <div>
          <p className="text-sm font-medium">No active workspace</p>
          <p className="text-xs text-muted-foreground mt-1">Select a workspace first.</p>
        </div>
      </div>
    );
  }

  const pending = invitations.filter((i) => i.status === "pending");

  return (
    <div className="space-y-6">

      {/* ---- header ---- */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Invite teammates and manage who has access to this workspace.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="gap-1.5 shrink-0"
          onClick={() => setInviteOpen((v) => !v)}
        >
          <UserPlus className="w-4 h-4" />
          Invite member
        </Button>
      </header>

      {/* ---- inline invite form (expands like secrets "add" form) ---- */}
      {inviteOpen && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-medium">Send an invitation</p>
          <div className="flex gap-3 flex-wrap items-end">
            <div className="space-y-1 flex-1 min-w-[200px]">
              <Label className="text-xs text-muted-foreground">Email address</Label>
              <Input
                type="email"
                autoFocus
                placeholder="colleague@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void handleInvite(); if (e.key === "Escape") setInviteOpen(false); }}
                className="text-sm"
              />
            </div>
            <div className="space-y-1 w-40">
              <Label className="text-xs text-muted-foreground">Role</Label>
              <Select value={inviteRole} onValueChange={(v) => setInviteRole(v as "member" | "admin")}>
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member</SelectItem>
                  <SelectItem value="admin">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex gap-2">
              <Button onClick={() => void handleInvite()} disabled={inviteSaving} size="sm" className="gap-1">
                <Check className="w-3.5 h-3.5" />
                {inviteSaving ? "Sending…" : "Send invite"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setInviteOpen(false); setInviteEmail(""); }}>
                <X className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            <strong>Member</strong> — sees their own private workers + all shared workers.{" "}
            <strong>Admin</strong> — sees all workspace data.
          </p>
        </div>
      )}

      {/* ---- active members ---- */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Active members</h2>

        {members.length === 0 ? (
          <div className="py-12 flex flex-col items-center gap-3 text-center">
            <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
              <Users className="w-5 h-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">No members yet</p>
              <p className="text-xs text-muted-foreground mt-1 max-w-xs">
                Invite a teammate to start collaborating on shared workers.
              </p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setInviteOpen(true)}>
              <UserPlus className="w-3.5 h-3.5" /> Invite member
            </Button>
          </div>
        ) : (
          <div className="space-y-1">
            {members.map((m) => (
              <div
                key={m.user_id}
                className="group flex items-center justify-between p-3 rounded-lg hover:bg-[var(--active-nav-bg)] transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {m.role === "admin"
                    ? <ShieldCheck className="w-4 h-4 text-muted-foreground shrink-0" />
                    : <Users className="w-4 h-4 text-muted-foreground shrink-0" />
                  }
                  <div className="min-w-0">
                    <p className="text-sm font-mono text-sm truncate">{m.user_id}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant={m.role === "admin" ? "default" : "secondary"} className="text-xs h-4 px-1.5">
                        {m.role}
                      </Badge>
                      {m.joined_at && (
                        <span className="text-xs text-muted-foreground">
                          Joined {new Date(m.joined_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={removingId === m.user_id || roleChangingId === m.user_id}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md opacity-0 group-hover:opacity-100 data-[state=open]:opacity-100 hover:bg-[var(--bg-2)] transition-opacity"
                  >
                    <MoreVertical className="w-3.5 h-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => void handleRoleChange(m.user_id, m.role === "admin" ? "member" : "admin")}
                      disabled={roleChangingId === m.user_id}
                    >
                      <ShieldCheck className="w-3.5 h-3.5 mr-2" />
                      Make {m.role === "admin" ? "member" : "admin"}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => void handleRemove(m.user_id)}
                      disabled={removingId === m.user_id}
                      className="text-destructive focus:text-destructive"
                    >
                      <X className="w-3.5 h-3.5 mr-2" />
                      {removingId === m.user_id ? "Removing…" : "Remove"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* ---- pending invitations ---- */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Pending invitations</h2>

        {pending.length === 0 ? (
          <p className="text-sm text-muted-foreground py-3">No pending invitations.</p>
        ) : (
          <div className="space-y-1">
            {pending.map((inv) => (
              <div
                key={inv.id}
                className="flex items-center justify-between p-3 rounded-lg hover:bg-[var(--active-nav-bg)] transition-colors"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Mail className="w-4 h-4 text-muted-foreground shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm truncate">{inv.email}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <Badge variant="secondary" className="text-xs h-4 px-1.5">{inv.role}</Badge>
                      {inv.expires_at && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Clock className="w-3 h-3" />
                          Expires {new Date(inv.expires_at).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => void handleRevoke(inv.id)}
                  disabled={revokingId === inv.id}
                >
                  {revokingId === inv.id ? "Revoking…" : "Revoke"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Accept-invite flow — auto-opens when ?invite=<token> is in the URL */}
      <AcceptInviteSection onJoined={() => void refresh(workspaceId)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Accept invite — shown as a collapsible section for users who have a token
// ---------------------------------------------------------------------------

function AcceptInviteSection({ onJoined }: { onJoined: () => void }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const urlToken = searchParams?.get("invite") ?? "";
  const [open, setOpen] = useState(!!urlToken);
  const [token, setToken] = useState(urlToken);
  const [accepting, setAccepting] = useState(false);
  const [pat, setPat] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleAccept() {
    if (!token.trim()) { toast.error("Paste your invitation token"); return; }
    setAccepting(true);
    try {
      const result = await apiFetch<{ workspace_id: string; role: string; pat_token: string }>(
        "/workspaces/accept-invite",
        { method: "POST", body: JSON.stringify({ token: token.trim() }) }
      );
      // Switch active workspace to the one just joined.
      window.localStorage.setItem(WS_KEY, result.workspace_id);
      setPat(result.pat_token);
      toast.success("Invitation accepted — you've joined the workspace");
      onJoined();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Invalid or expired invitation");
    } finally {
      setAccepting(false);
    }
  }

  function handleCopy() {
    if (!pat) return;
    void navigator.clipboard.writeText(pat).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleDone() {
    router.push("/app/workers");
  }

  return (
    <section className="border-t border-border pt-6 space-y-3">
      <button
        type="button"
        className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▾" : "▸"} Have an invitation? Accept it here
      </button>
      {open && !pat && (
        <div className="flex gap-2 flex-wrap items-center">
          <Input
            placeholder="Paste invitation token (wsi_…)"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void handleAccept(); }}
            className="text-sm font-mono flex-1 min-w-[260px]"
          />
          <Button size="sm" disabled={accepting} onClick={() => void handleAccept()}>
            {accepting ? "Accepting…" : "Accept"}
          </Button>
        </div>
      )}
      {pat && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-3">
          <p className="text-sm font-medium">You're in. Save your API token before continuing.</p>
          <p className="text-xs text-muted-foreground">
            This token is shown <strong>once only</strong> and cannot be retrieved again. Use it as your{" "}
            <code className="bg-muted px-1 py-0.5 rounded font-mono">x-floom-token</code> header.
          </p>
          <div className="flex gap-2">
            <Input readOnly value={pat} className="font-mono text-xs" onFocus={(e) => e.target.select()} />
            <Button size="sm" variant="secondary" onClick={handleCopy}>
              {copied ? "Copied!" : "Copy"}
            </Button>
          </div>
          <Button size="sm" className="w-full" onClick={handleDone}>
            I've saved my token — go to workspace
          </Button>
        </div>
      )}
    </section>
  );
}
