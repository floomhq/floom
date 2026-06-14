"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AlertTriangle, Check, ShieldCheck, Trash2, UserPlus, Users, X } from "lucide-react";

import { api } from "@/lib/api";
import type { CurrentUser, WorkspaceMember, WorkspaceMembersResponse, WorkspaceRole } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

type EditableRole = "admin" | "member";

const ROLE_LABEL: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
};

function RoleBadge({ role }: { role: WorkspaceRole }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-[var(--radius-pill)] px-2 py-0.5 text-xs font-medium",
        role === "owner"
          ? "bg-[color-mix(in_srgb,var(--accent)_16%,transparent)] text-[var(--accent)]"
          : "bg-[var(--bg-2)] text-[var(--ink-soft)]",
      )}
    >
      {role === "owner" ? <ShieldCheck className="size-3" /> : null}
      {ROLE_LABEL[role]}
    </span>
  );
}

function StatusBadge({ member }: { member: WorkspaceMember }) {
  if (member.status === "active") return null;
  return (
    <span className="rounded-[var(--radius-pill)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px] font-medium text-[var(--ink-mute)]">
      {member.status === "invited" ? "Invited" : "Removed"}
    </span>
  );
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function memberLabel(member: WorkspaceMember, currentUser?: CurrentUser | null, isMe?: boolean): string {
  const fallbackUser = isMe
    ? currentUser?.display_name?.trim() || currentUser?.username?.trim() || currentUser?.email?.trim()
    : null;
  const label = member.display_name?.trim() || member.email?.trim() || fallbackUser || "";
  if (label) return label;
  return looksLikeUuid(member.user_id) ? "Workspace member" : member.user_id;
}

function memberInitial(member: WorkspaceMember, currentUser?: CurrentUser | null, isMe?: boolean): string {
  return memberLabel(member, currentUser, isMe).slice(0, 2).toUpperCase();
}

function memberDate(member: WorkspaceMember): string | null {
  const raw = member.created_at || member.updated_at;
  if (!raw) return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return null;
  const prefix = member.status === "invited" ? "Invited" : "Joined";
  return `${prefix} ${date.toLocaleDateString()}`;
}

function ReadOnlyNotice() {
  return (
    <Alert>
      <AlertTriangle className="size-4" />
      <AlertTitle>View only</AlertTitle>
      <AlertDescription>
        Member management controls are hidden because this account is not Owner or Admin.
      </AlertDescription>
    </Alert>
  );
}

function LoadingMembers() {
  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-4 w-72" />
        </div>
        <Skeleton className="h-9 w-28" />
      </header>
      <section className="space-y-3">
        <Skeleton className="h-4 w-24" />
        {Array.from({ length: 3 }).map((_, index) => (
          <Skeleton key={index} className="h-16 w-full" />
        ))}
      </section>
    </div>
  );
}

export default function MembersPage() {
  const [data, setData] = useState<WorkspaceMembersResponse | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<EditableRole>("member");
  const [adding, setAdding] = useState(false);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<
    | { kind: "remove"; member: WorkspaceMember }
    | { kind: "transfer"; member: WorkspaceMember }
    | null
  >(null);

  const load = useCallback(async () => {
    try {
      const response = await api.members.list();
      setData(response);
      setError(null);
    } catch (err) {
      setError((err as Error).message || "Failed to load members");
    }
  }, []);

  useEffect(() => {
    void load();
    api.me().then(setCurrentUser).catch(() => setCurrentUser(null));
  }, [load]);

  const myRole = data?.my_role ?? null;
  const myMember = data?.members.find((member) => member.user_id === data.my_user_id) ?? null;
  const effectiveMyRole = myRole ?? myMember?.role ?? null;
  const canManage = effectiveMyRole === "owner" || effectiveMyRole === "admin";
  const isOwner = effectiveMyRole === "owner" || myMember?.role === "owner";

  const sortedMembers = useMemo(() => data?.members ?? [], [data?.members]);
  const invitedCount = sortedMembers.filter((member) => member.status === "invited").length;

  async function handleAdd(event: FormEvent) {
    event.preventDefault();
    const trimmed = email.trim();
    if (!trimmed || adding || !canManage) return;
    setAdding(true);
    try {
      await api.members.invite(trimmed, role);
      setEmail("");
      setRole("member");
      setAddOpen(false);
      toast.success(`Added ${trimmed}`);
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to add member");
    } finally {
      setAdding(false);
    }
  }

  async function handleRoleChange(member: WorkspaceMember, nextRole: EditableRole) {
    if (member.role === nextRole || !isOwner) return;
    setBusyUser(member.user_id);
    try {
      await api.members.setRole(member.user_id, nextRole);
      toast.success(`${memberLabel(member, currentUser, member.user_id === data?.my_user_id)} is now ${ROLE_LABEL[nextRole]}`);
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to change role");
    } finally {
      setBusyUser(null);
    }
  }

  async function runPendingAction() {
    if (!pendingAction) return;
    const action = pendingAction;
    setPendingAction(null);
    setBusyUser(action.member.user_id);
    try {
      if (action.kind === "remove") {
        await api.members.remove(action.member.user_id);
        toast.success(`Removed ${memberLabel(action.member, currentUser, action.member.user_id === data?.my_user_id)}`);
      } else {
        await api.members.transferOwner(action.member.user_id);
        toast.success(`${memberLabel(action.member, currentUser, action.member.user_id === data?.my_user_id)} is now the Owner`);
      }
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Member action failed");
    } finally {
      setBusyUser(null);
    }
  }

  if (!data && !error) return <LoadingMembers />;
  if (error && !data) {
    return (
      <div className="space-y-6">
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
            <p className="mt-1 max-w-2xl text-sm text-[var(--ink-soft)]">
              Manage people and roles for the active workspace.
            </p>
          </div>
        </header>
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn&apos;t load members</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Members</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--ink-soft)]">
            Manage people and roles for the active workspace.
          </p>
        </div>
        {canManage ? (
          <Button size="sm" variant="outline" onClick={() => setAddOpen((open) => !open)} className="gap-1.5">
            <UserPlus className="size-4" />
            Add member
          </Button>
        ) : null}
      </header>

      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn&apos;t load members</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!canManage ? <ReadOnlyNotice /> : null}

      {canManage && addOpen ? (
        <Card className="[border:var(--bd-card)] bg-card shadow-none">
          <CardHeader>
            <CardTitle className="text-sm font-medium">Add member</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleAdd} className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-end">
              <div className="min-w-[220px] flex-1 space-y-1.5">
                <Label htmlFor="member-email" className="text-xs text-muted-foreground">
                  Email address
                </Label>
                <Input
                  id="member-email"
                  type="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="teammate@company.com"
                  className="h-11 text-sm [border:var(--bd-card)] sm:h-9"
                  maxLength={254}
                  autoFocus
                />
              </div>
              <div className="w-full space-y-1.5 sm:w-40">
                <Label htmlFor="member-role" className="text-xs text-muted-foreground">
                  Role
                </Label>
                <Select value={role} onValueChange={(value) => setRole(value as EditableRole)}>
                  <SelectTrigger id="member-role" className="h-11 [border:var(--bd-card)] sm:h-9">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">Member</SelectItem>
                    <SelectItem value="admin">Admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="flex gap-2">
                <Button type="submit" disabled={!email.trim() || adding} size="sm" className="h-11 flex-1 gap-1 sm:h-9 sm:flex-none">
                  <Check className="size-4" />
                  {adding ? "Adding..." : "Add"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="h-11 px-3 sm:h-9 sm:px-2"
                  onClick={() => {
                    setAddOpen(false);
                    setEmail("");
                    setRole("member");
                  }}
                  aria-label="Close add member form"
                >
                  <X className="size-4" />
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      ) : null}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-medium text-muted-foreground">Workspace members</h2>
          {data ? (
            <p className="text-xs text-[var(--ink-mute)]">
              {sortedMembers.length} total{invitedCount ? `, ${invitedCount} invited` : ""}
            </p>
          ) : null}
        </div>

        {sortedMembers.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-12 text-center">
            <div className="flex size-10 items-center justify-center rounded-[var(--radius-pill)] bg-muted">
              <Users className="size-5 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm font-medium text-foreground">No members yet</p>
              <p className="mt-1 max-w-xs text-xs text-muted-foreground">
                Add the first teammate to this workspace.
              </p>
            </div>
            {canManage ? (
              <Button size="sm" variant="outline" onClick={() => setAddOpen(true)} className="mt-1 gap-1.5">
                <UserPlus className="size-3.5" />
                Add member
              </Button>
            ) : null}
          </div>
        ) : (
          <div className="space-y-1">
            {sortedMembers.map((member) => {
              const isMe = member.user_id === data?.my_user_id;
              const isBusy = busyUser === member.user_id;
              const label = memberLabel(member, currentUser, isMe);
              const date = memberDate(member);
              const canChangeRole = isOwner && member.role !== "owner" && !isMe;
              const canRemove =
                canManage &&
                member.role !== "owner" &&
                !isMe &&
                !(effectiveMyRole === "admin" && member.role === "admin");
              const canTransfer = isOwner && member.role !== "owner" && member.status === "active";

              return (
                <div
                  key={member.user_id}
                  className="flex flex-col gap-3 rounded-lg p-3 transition-colors hover:bg-[var(--active-nav-bg)] sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="grid size-10 shrink-0 place-items-center rounded-[var(--radius-button)] bg-[var(--bg-2)] text-[11px] font-medium text-foreground">
                      {memberInitial(member, currentUser, isMe)}
                    </div>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{label}</span>
                        {isMe ? <span className="text-[11px] text-[var(--ink-mute)]">You</span> : null}
                        <StatusBadge member={member} />
                      </div>
                      {member.email && member.email !== label ? (
                        <p className="truncate text-xs text-[var(--ink-mute)]">{member.email}</p>
                      ) : null}
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <RoleBadge role={member.role} />
                        {date ? <span className="text-xs text-[var(--ink-mute)]">{date}</span> : null}
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                    {canChangeRole ? (
                      <Select
                        value={member.role}
                        onValueChange={(value) => void handleRoleChange(member, value as EditableRole)}
                        disabled={isBusy}
                      >
                        <SelectTrigger className="h-8 w-32 [border:var(--bd-card)] text-xs" aria-label={`Change role for ${label}`}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="member">Member</SelectItem>
                          <SelectItem value="admin">Admin</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : null}
                    {canTransfer ? (
                      <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => setPendingAction({ kind: "transfer", member })}>
                        Transfer owner
                      </Button>
                    ) : null}
                    {canRemove ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="gap-1 text-destructive"
                        disabled={isBusy}
                        onClick={() => setPendingAction({ kind: "remove", member })}
                      >
                        <Trash2 className="size-3.5" />
                        Remove
                      </Button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      <Dialog open={!!pendingAction} onOpenChange={(open) => { if (!open) setPendingAction(null); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{pendingAction?.kind === "transfer" ? "Transfer ownership?" : "Remove member?"}</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            {pendingAction?.kind === "transfer"
              ? `Transfer ownership to ${pendingAction ? memberLabel(pendingAction.member, currentUser, pendingAction.member.user_id === data?.my_user_id) : "this member"}? You will be demoted to Admin.`
              : `Remove ${pendingAction ? memberLabel(pendingAction.member, currentUser, pendingAction.member.user_id === data?.my_user_id) : "this member"} from this workspace?`}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingAction(null)}>Cancel</Button>
            <Button variant={pendingAction?.kind === "remove" ? "destructive" : "default"} onClick={() => void runPendingAction()}>
              {pendingAction?.kind === "transfer" ? "Transfer" : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
