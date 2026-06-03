"use client";

// Members page (STEP 2 — Codex members design, build-order step 2).
//
// ONE model for BOTH products. On the OSS engine this is the single-owner
// degenerate case: it renders the local user as Owner, with the invite
// affordance present. Cloud serves the identical UI with real members (no
// fork). Follows the Notion/Linear members-settings convention: a list of
// members with their role, an invite-by-email row, and per-member
// change-role / remove / transfer-ownership actions gated by the caller's role.

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { ChevronDown, Crown, MoreHorizontal, ShieldCheck, UserPlus } from "lucide-react";

import { api } from "@/lib/api";
import type {
  WorkspaceMember,
  WorkspaceMembersResponse,
  WorkspaceRole,
} from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

function RoleBadge({ role }: { role: WorkspaceRole }) {
  const Icon = role === "owner" ? Crown : role === "admin" ? ShieldCheck : null;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-2 py-0.5 text-xs font-medium",
        role === "owner"
          ? "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]"
          : "bg-[var(--bg-2)] text-[var(--ink-soft)]"
      )}
    >
      {Icon ? <Icon className="size-3" /> : null}
      {ROLE_LABEL[role]}
    </span>
  );
}

function memberLabel(m: WorkspaceMember): string {
  return m.display_name?.trim() || m.email?.trim() || m.user_id;
}

function memberInitial(m: WorkspaceMember): string {
  const base = m.display_name?.trim() || m.email?.trim() || m.user_id || "?";
  return base.slice(0, 2).toUpperCase();
}

export default function MembersPage() {
  const [data, setData] = useState<WorkspaceMembersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviting, setInviting] = useState(false);
  const [busyUser, setBusyUser] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api.members.list();
      setData(res);
      setError(null);
    } catch (err) {
      setError((err as Error).message || "Failed to load members");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const myRole = data?.my_role ?? null;
  const canManage = myRole === "owner" || myRole === "admin";
  const isOwner = myRole === "owner";

  const sortedMembers = useMemo(() => data?.members ?? [], [data]);

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email || inviting) return;
    setInviting(true);
    try {
      await api.members.invite(email, inviteRole);
      setInviteEmail("");
      toast.success(`Invited ${email}`);
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to invite member");
    } finally {
      setInviting(false);
    }
  }

  async function handleSetRole(m: WorkspaceMember, role: "admin" | "member") {
    if (m.role === role) return;
    setBusyUser(m.user_id);
    try {
      await api.members.setRole(m.user_id, role);
      toast.success(`${memberLabel(m)} is now ${ROLE_LABEL[role]}`);
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to change role");
    } finally {
      setBusyUser(null);
    }
  }

  async function handleRemove(m: WorkspaceMember) {
    if (
      !window.confirm(
        `Remove ${memberLabel(m)} from this workspace? They lose access to workspace-shared assets.`
      )
    )
      return;
    setBusyUser(m.user_id);
    try {
      await api.members.remove(m.user_id);
      toast.success(`Removed ${memberLabel(m)}`);
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to remove member");
    } finally {
      setBusyUser(null);
    }
  }

  async function handleTransfer(m: WorkspaceMember) {
    if (
      !window.confirm(
        `Transfer ownership to ${memberLabel(m)}? You will be demoted to Admin. This cannot be undone by you alone.`
      )
    )
      return;
    setBusyUser(m.user_id);
    try {
      await api.members.transferOwner(m.user_id);
      toast.success(`${memberLabel(m)} is now the Owner`);
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to transfer ownership");
    } finally {
      setBusyUser(null);
    }
  }

  if (!data && !error) {
    return (
      <div className="space-y-6">
        <div>
          <Skeleton className="h-8 w-40" />
          <Skeleton className="mt-2 h-4 w-72" />
        </div>
        <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton
              key={i}
              className="h-16 w-full rounded-none border-b border-[var(--border-default)] last:border-b-0"
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Members</h1>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          People in this workspace and what they can do. Owners and admins manage
          membership; everyone can run workspace-shared workers.
        </p>
      </div>

      {error ? (
        <div className="rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-3 text-sm text-[var(--ink-soft)]">
          {error}
        </div>
      ) : null}

      {canManage ? (
        <form
          onSubmit={handleInvite}
          className="flex flex-col gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 sm:flex-row sm:items-center"
        >
          <div className="flex flex-1 items-center gap-2">
            <UserPlus className="size-4 shrink-0 text-[var(--ink-mute)]" />
            <Input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              placeholder="teammate@company.com"
              className="flex-1"
              aria-label="Invite member by email"
              maxLength={254}
            />
          </div>
          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-transparent px-2.5 text-sm text-[var(--ink-soft)] hover:bg-[var(--active-nav-bg)] hover:text-ink"
                aria-label="Select invite role"
              >
                {ROLE_LABEL[inviteRole]}
                <ChevronDown className="size-3.5 opacity-60" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-40 p-1">
                <DropdownMenuItem onClick={() => setInviteRole("member")}>
                  Member
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setInviteRole("admin")}>
                  Admin
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button type="submit" disabled={!inviteEmail.trim() || inviting}>
              {inviting ? "Inviting…" : "Invite"}
            </Button>
          </div>
        </form>
      ) : null}

      <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)]">
        {sortedMembers.map((m) => {
          const isMe = m.user_id === data?.my_user_id;
          const isBusy = busyUser === m.user_id;
          // Action menu is shown only when the caller can do something to this row.
          const canChangeRole = isOwner && m.role !== "owner" && !isMe;
          const canRemove =
            canManage &&
            m.role !== "owner" &&
            !isMe &&
            !(myRole === "admin" && m.role === "admin");
          const canTransfer = isOwner && m.role !== "owner" && m.status === "active";
          const hasActions = canChangeRole || canRemove || canTransfer;

          return (
            <div
              key={m.user_id}
              className="flex items-center gap-3 border-b border-[var(--border-default)] px-4 py-3 last:border-b-0"
            >
              <div className="grid size-9 shrink-0 place-items-center rounded-full border border-[var(--border-soft)] bg-[var(--bg-2)] text-[11px] font-medium text-foreground">
                {memberInitial(m)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">
                    {memberLabel(m)}
                  </span>
                  {isMe ? (
                    <span className="text-[11px] text-[var(--ink-mute)]">You</span>
                  ) : null}
                </div>
                {m.email && m.email !== memberLabel(m) ? (
                  <p className="truncate text-xs text-[var(--ink-mute)]">{m.email}</p>
                ) : null}
              </div>
              {m.status === "invited" ? (
                <span className="rounded-[var(--radius-pill)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px] text-[var(--ink-mute)]">
                  Invited
                </span>
              ) : null}
              <RoleBadge role={m.role} />
              {hasActions ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    disabled={isBusy}
                    className="inline-flex size-8 items-center justify-center rounded-[var(--radius-button)] text-[var(--ink-soft)] hover:bg-[var(--active-nav-bg)] hover:text-ink disabled:opacity-50"
                    aria-label={`Actions for ${memberLabel(m)}`}
                  >
                    <MoreHorizontal className="size-4" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-48 p-1">
                    {canChangeRole ? (
                      m.role === "member" ? (
                        <DropdownMenuItem onClick={() => void handleSetRole(m, "admin")}>
                          Make admin
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem onClick={() => void handleSetRole(m, "member")}>
                          Make member
                        </DropdownMenuItem>
                      )
                    ) : null}
                    {canTransfer ? (
                      <DropdownMenuItem onClick={() => void handleTransfer(m)}>
                        Transfer ownership…
                      </DropdownMenuItem>
                    ) : null}
                    {canRemove ? (
                      <>
                        {canChangeRole || canTransfer ? (
                          <DropdownMenuSeparator className="-mx-1 my-1" />
                        ) : null}
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => void handleRemove(m)}
                        >
                          Remove from workspace
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : (
                <div className="size-8" aria-hidden="true" />
              )}
            </div>
          );
        })}
        {sortedMembers.length === 0 ? (
          <div className="px-4 py-8 text-center text-sm text-[var(--ink-mute)]">
            No members yet.
          </div>
        ) : null}
      </div>
    </div>
  );
}
