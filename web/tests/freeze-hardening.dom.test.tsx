// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { clearClientLogoutState } from "@/lib/auth/logout-cleanup";
import { PERSIST_STORAGE_KEY } from "@/lib/query/persist";
import { userFacingChatErrorMessage } from "@/lib/useChatStream";

const ROOT = resolve(__dirname, "..");

function source(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

describe("code-freeze hardening fixes", () => {
  beforeEach(() => {
    localStorage.clear();
    document.cookie = "workeros.activeWorkspaceId=ws_123; Path=/";
  });

  it("does not surface structured/internal Emily errors into chat text", () => {
    expect(userFacingChatErrorMessage({ detail: [{ msg: "field required" }] })).toBe(
      "Emily could not complete that request.",
    );
    expect(userFacingChatErrorMessage('{"detail":"workspace_id ws_secret"}')).toBe(
      "Emily could not complete that request.",
    );
    expect(userFacingChatErrorMessage("Worker list failed")).toBe("Worker list failed");
  });

  it("clears auth-scoped browser state on logout while leaving unrelated preferences", () => {
    localStorage.setItem(PERSIST_STORAGE_KEY, "cache");
    localStorage.setItem("workeros.activeWorkspaceId", "ws_123");
    localStorage.setItem("workeros.emily.conversationId", "conv_123");
    localStorage.setItem("workeros:favorites", '["worker"]');
    localStorage.setItem("floom.workerDetail.pinnedTabs", '["Source"]');
    localStorage.setItem("workeros.workerInputTemplates.worker_a", "{}");
    localStorage.setItem("floom-theme", "day");

    clearClientLogoutState();

    expect(localStorage.getItem(PERSIST_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("workeros.activeWorkspaceId")).toBeNull();
    expect(localStorage.getItem("workeros.emily.conversationId")).toBeNull();
    expect(localStorage.getItem("workeros:favorites")).toBeNull();
    expect(localStorage.getItem("floom.workerDetail.pinnedTabs")).toBeNull();
    expect(localStorage.getItem("workeros.workerInputTemplates.worker_a")).toBeNull();
    expect(localStorage.getItem("floom-theme")).toBe("day");
  });

  it("opens OAuth popups without an opener", () => {
    const src = source("lib/oauth-popup.ts");
    expect(src).toContain("noopener,noreferrer");
    expect(src).toContain("popup.opener = null");
  });

  it("treats workspace owners as Git workspace admins", () => {
    const src = source("components/GitWorkspacePanel.tsx");
    expect(src).toContain("computeIsAdmin(me)");
    expect(src).not.toContain('me.role === "admin";');
  });

  it("hides workspace export unless the current user is owner/admin", () => {
    const src = source("components/layout/WorkspaceSwitcher.tsx");
    expect(src).toContain("canExportWorkspace");
    expect(src).toContain("{canExportWorkspace && (");
    expect(src).toContain("setCanExportWorkspace(computeIsAdmin(me))");
  });

  it("limits public approval preview/download links to same-origin paths", () => {
    const src = source("app/approvals/review/page.tsx");
    expect(src).toContain('href.startsWith("/") && !href.startsWith("//")');
    expect(src).toContain("parsed.origin === window.location.origin");
    expect(src).not.toContain('parsed.protocol === "http:" || parsed.protocol === "https:"');
  });

  it("exposes secret creator metadata and gates row mutation actions", () => {
    expect(source("../engine/apps/api/models.py")).toContain("user_id: Optional[str] = None");
    expect(source("../engine/apps/api/routers/secrets.py")).toContain('user_id=db_row.get("user_id")');
    const src = source("app/connections/secrets/page.tsx");
    expect(src).toContain("canMutateSecretItem");
    expect(src).toContain("{canMutate && (");
    expect(src).toContain("canMutate && updatingName === s.name");
  });
});
