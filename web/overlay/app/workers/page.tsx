"use client";

import { useEffect, useMemo, useState } from "react";

import WorkersCollection, { type WorkersExtraView } from "@/app/workers/WorkersCollection";
import { CloudWorkspaceAdminWorkersView } from "@/app/workers/CloudWorkspaceAdminWorkersView";

const API_PROXY_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE ?? "/api/proxy";
const ACTIVE_WORKSPACE_STORAGE_KEY = "workeros.activeWorkspaceId";

function getActiveWorkspaceId(): string | null {
  if (typeof window === "undefined") return null;
  const value = window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  return value && value !== "local-default" ? value : null;
}

function workspaceHeaders(): Headers {
  const headers = new Headers({ "Content-Type": "application/json" });
  const workspaceId = getActiveWorkspaceId();
  if (workspaceId) headers.set("x-workeros-workspace", workspaceId);
  return headers;
}

export default function CloudWorkersPage() {
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/app/api/me")
      .then((response) => response.json())
      .then((data) => {
        const email = data?.user?.email as string | undefined;
        const workspaceId = getActiveWorkspaceId();
        if (!email || !workspaceId || cancelled) return;
        return fetch(`${API_PROXY_BASE}/workspaces/${workspaceId}/members`, {
          headers: workspaceHeaders(),
        })
          .then((response) => (response.ok ? response.json() : null))
          .then((members: { owner?: { email: string }; members?: { email: string; role: string }[] } | null) => {
            if (!members || cancelled) return;
            const ownsWorkspace = members.owner?.email === email;
            const isAdminMember = (members.members ?? []).some(
              (member) => member.email === email && member.role === "admin"
            );
            setIsAdmin(ownsWorkspace || isAdminMember);
          });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const extraViews = useMemo<WorkersExtraView[]>(
    () =>
      isAdmin
        ? [
            {
              key: "workspace-admin",
              label: "Admin",
              render: () => <CloudWorkspaceAdminWorkersView />,
            },
          ]
        : [],
    [isAdmin]
  );

  return <WorkersCollection initialWorkers={[]} extraViews={extraViews} />;
}
