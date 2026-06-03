"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE ?? "/api/proxy";

function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function apiUrl(path: string) {
  return `${API_BASE}${path}`;
}

type Member = {
  id: string;
  user_id: string;
  role: string;
  joined_at: string | null;
};

type Invitation = {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: string;
  expires_at: string | null;
};

export default function MembersPage() {
  return <MembersContent />;
}

function MembersContent() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Invite dialog state
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState<string | null>(null);

  useEffect(() => {
    const ws = getCookie("workeros_active_workspace");
    setWorkspaceId(ws);
    if (ws) {
      void loadData(ws);
    } else {
      setLoading(false);
      setError("No active workspace. Select a workspace first.");
    }
  }, []);

  async function loadData(ws: string) {
    setLoading(true);
    setError(null);
    try {
      const [membersResp, invResp] = await Promise.all([
        fetch(apiUrl(`/workspaces/${ws}/members`)),
        fetch(apiUrl(`/workspaces/${ws}/invitations`)),
      ]);
      if (membersResp.ok) {
        const data = (await membersResp.json()) as { members: Member[] };
        setMembers(data.members ?? []);
      }
      if (invResp.ok) {
        const data = (await invResp.json()) as { invitations: Invitation[] };
        setInvitations(data.invitations ?? []);
      }
    } catch {
      setError("Failed to load members.");
    } finally {
      setLoading(false);
    }
  }

  async function handleInvite() {
    if (!workspaceId || !inviteEmail.trim()) return;
    setInviteBusy(true);
    setInviteError(null);
    try {
      const resp = await fetch(apiUrl(`/workspaces/${workspaceId}/members/invite`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });
      if (!resp.ok) {
        const body = (await resp.json().catch(() => ({}))) as { detail?: string };
        setInviteError(body.detail ?? "Failed to send invite.");
        return;
      }
      setInviteOpen(false);
      setInviteEmail("");
      setInviteRole("member");
      void loadData(workspaceId);
    } catch {
      setInviteError("Network error. Try again.");
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleRevoke(invId: string) {
    if (!workspaceId) return;
    await fetch(apiUrl(`/workspaces/${workspaceId}/invitations/${invId}`), { method: "DELETE" });
    void loadData(workspaceId);
  }

  async function handleRemove(userId: string) {
    if (!workspaceId) return;
    await fetch(apiUrl(`/workspaces/${workspaceId}/members/${userId}`), { method: "DELETE" });
    void loadData(workspaceId);
  }

  async function handleRoleChange(userId: string, newRole: string) {
    if (!workspaceId) return;
    await fetch(apiUrl(`/workspaces/${workspaceId}/members/${userId}/role`), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role: newRole }),
    });
    void loadData(workspaceId);
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground">Loading…</div>;
  }

  if (error) {
    return <div className="text-sm text-destructive">{error}</div>;
  }

  const pendingInvites = invitations.filter((i) => i.status === "pending");

  return (
    <div className="max-w-2xl space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Members</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage who has access to this workspace.
          </p>
        </div>
        <Button size="sm" onClick={() => setInviteOpen(true)}>
          Invite member
        </Button>
      </div>

      {/* Active members */}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Active members
        </h2>
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">No members yet. Invite someone to collaborate.</p>
        ) : (
          <div className="divide-y rounded-lg border">
            {members.map((m) => (
              <div key={m.user_id} className="flex items-center justify-between px-4 py-3">
                <div className="space-y-0.5">
                  <p className="text-sm font-mono text-muted-foreground">{m.user_id}</p>
                  {m.joined_at && (
                    <p className="text-xs text-muted-foreground">
                      Joined {new Date(m.joined_at).toLocaleDateString()}
                    </p>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <Select
                    value={m.role}
                    onValueChange={(v) => void handleRoleChange(m.user_id, v)}
                  >
                    <SelectTrigger className="h-7 w-24 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="member">Member</SelectItem>
                      <SelectItem value="admin">Admin</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => void handleRemove(m.user_id)}
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Pending invitations */}
      {pendingInvites.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Pending invitations
          </h2>
          <div className="divide-y rounded-lg border">
            {pendingInvites.map((inv) => (
              <div key={inv.id} className="flex items-center justify-between px-4 py-3">
                <div className="space-y-0.5">
                  <p className="text-sm">{inv.email}</p>
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary" className="text-xs">
                      {inv.role}
                    </Badge>
                    {inv.expires_at && (
                      <span className="text-xs text-muted-foreground">
                        Expires {new Date(inv.expires_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleRevoke(inv.id)}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Invite dialog */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Invite a member</DialogTitle>
            <DialogDescription>
              They will receive an email with a 7-day invitation link.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="invite-email">
                Email address
              </label>
              <Input
                id="invite-email"
                type="email"
                placeholder="colleague@example.com"
                value={inviteEmail}
                onChange={(e) => setInviteEmail(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium" htmlFor="invite-role">
                Role
              </label>
              <Select
                value={inviteRole}
                onValueChange={(v) => setInviteRole(v as "member" | "admin")}
              >
                <SelectTrigger id="invite-role">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">Member — sees own workers + shared workers</SelectItem>
                  <SelectItem value="admin">Admin — sees all workspace data</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {inviteError && <p className="text-sm text-destructive">{inviteError}</p>}
          </div>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button disabled={inviteBusy || !inviteEmail.trim()} onClick={() => void handleInvite()}>
              {inviteBusy ? "Sending…" : "Send invite"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
