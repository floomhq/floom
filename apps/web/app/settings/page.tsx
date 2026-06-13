"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type {
  CurrentUser,
  LocalWorkspaceListResponse,
  PersonalAccessToken,
  PlatformConfig,
  SystemInfo,
  VersionSummary,
  WorkspaceAgentInfo,
  WorkspaceMember,
  WorkspaceMembersResponse,
  WorkspaceRole,
  WorkspaceToken,
} from "@/lib/types";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { CollectionView } from "@/components/collection/CollectionView";
import { emptyState } from "@/lib/collection/url-state";
import type { CollectionConfig, CollectionState } from "@/lib/collection/types";
import { SETTINGS_NAV, settingsGroup, groupLabel } from "@/lib/settings/nav-groups";
import { resolveWorkspaceName } from "@/lib/workspace/display-name";
import { GitWorkspacePanel } from "@/components/GitWorkspacePanel";
import { ThemeModeToggleGroup } from "@/components/ThemeModeToggleGroup";
import { SlackConnect } from "@/components/assistant/SlackConnect";
import { ClaimSuccessOverlay, type ClaimChannel } from "@/components/channels/ClaimSuccessOverlay";
import { VersionHistoryMenu } from "@/components/VersionHistoryMenu";
import { AssetVisibilityControl } from "@/components/AssetVisibilityControl";
import { EmilyAvatar } from "@/components/emily/EmilyAvatar";
import { modelLabel } from "@/lib/model-labels";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  Bot,
  ChevronRight,
  CheckCircle2,
  Code2,
  Copy,
  History,
  KeyRound,
  MessageSquare,
  Palette,
  QrCode,
  RotateCcw,
  Save,
  Settings,
  ShieldAlert,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";

function PersonalAccessTokensPanel() {
  const [tokens, setTokens] = useState<PersonalAccessToken[] | null>(null);
  const [newTokenName, setNewTokenName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.tokens.list();
      setTokens(list);
    } catch {
      // /auth/tokens 404/401 means multi-member not active — hide silently
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (tokens === null) return null; // Not yet loaded or not available

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newTokenName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreatedToken(null);
    try {
      const result = await api.tokens.create(name);
      setCreatedToken(result.token);
      setNewTokenName("");
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to create token");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string, name: string) {
    try {
      await api.tokens.revoke(id);
      toast.success(`Revoked "${name}"`);
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to revoke token");
    }
  }

  async function copyToken(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Token copied to clipboard");
    } catch {
      toast.error("Could not copy to clipboard");
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">Personal access tokens</h2>
      <p className="text-sm text-muted-foreground">
        Use tokens to authenticate API and MCP requests without a shared secret.
        Token values are shown once — store them securely.
      </p>

      {createdToken && (
        <Alert>
          <CheckCircle2 className="size-4" />
          <AlertTitle>Token created</AlertTitle>
          <AlertDescription>
            <div className="mt-2 flex items-center gap-2 rounded-md bg-muted px-3 py-2 font-mono text-xs">
              <span className="flex-1 break-all">{createdToken}</span>
              <button
                type="button"
                onClick={() => void copyToken(createdToken)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
              >
                <Copy className="size-3.5" />
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              This value won&apos;t be shown again.
            </p>
          </AlertDescription>
        </Alert>
      )}

      <form onSubmit={handleCreate} className="flex gap-2">
        <Input
          placeholder="Token name (e.g. ci-pipeline)"
          value={newTokenName}
          onChange={(e) => setNewTokenName(e.target.value)}
          className="max-w-xs"
        />
        <Button type="submit" size="sm" disabled={!newTokenName.trim() || creating}>
          {creating ? "Creating…" : "Create token"}
        </Button>
      </form>

      {tokens.length > 0 ? (
        <div className="space-y-1">
          {tokens.map((t) => (
            <div key={t.id} className="flex items-center gap-3 rounded-lg [border:var(--bd-card)] px-3 py-2 text-sm">
              <div className="flex-1 min-w-0">
                <span className="font-medium">{t.name}</span>
                {t.last_used_at && (
                  <span className="ml-2 text-xs text-muted-foreground">
                    last used {new Date(t.last_used_at).toLocaleDateString()}
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void handleRevoke(t.id, t.name)}
                className="text-muted-foreground hover:text-destructive"
                aria-label={`Revoke ${t.name}`}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No tokens yet.</p>
      )}
    </section>
  );
}

// Workspace token (wst_): admin-only API access to workspace-shared workers.
// Mirrors PersonalAccessTokensPanel; members get 403 → admins-only notice.
export function WorkspaceTokensPanel() {
  const [tokens, setTokens] = useState<WorkspaceToken[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [newTokenName, setNewTokenName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createdToken, setCreatedToken] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.workspace.tokens.list();
      setTokens(list);
      setForbidden(false);
    } catch {
      // 403 (member) or 404 (endpoint not active) — show the admins-only note.
      setForbidden(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const name = newTokenName.trim();
    if (!name || creating) return;
    setCreating(true);
    setCreatedToken(null);
    try {
      const result = await api.workspace.tokens.create(name);
      setCreatedToken(result.token);
      setNewTokenName("");
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to create workspace token");
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(id: string, name: string) {
    try {
      await api.workspace.tokens.revoke(id);
      toast.success(`Revoked "${name}"`);
      await load();
    } catch (err) {
      toast.error((err as Error).message || "Failed to revoke workspace token");
    }
  }

  async function copyToken(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Token copied to clipboard");
    } catch {
      toast.error("Could not copy to clipboard");
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">Workspace token</h2>
      {forbidden ? (
        <p className="text-sm text-muted-foreground">
          Only workspace admins can manage the workspace token.
        </p>
      ) : tokens === null ? null : (
        <>
          <p className="text-sm text-muted-foreground">
            A workspace token gives API access to workspace-shared workers only — no
            private workers. Admins only. Token values are shown once — store them
            securely.
          </p>

          {createdToken && (
            <Alert>
              <CheckCircle2 className="size-4" />
              <AlertTitle>Workspace token created</AlertTitle>
              <AlertDescription>
                <div className="mt-2 flex items-center gap-2 rounded-md bg-muted px-3 py-2 font-mono text-xs">
                  <span className="flex-1 break-all">{createdToken}</span>
                  <button
                    type="button"
                    onClick={() => void copyToken(createdToken)}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                    aria-label="Copy workspace token"
                  >
                    <Copy className="size-3.5" />
                  </button>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  This value won&apos;t be shown again.
                </p>
              </AlertDescription>
            </Alert>
          )}

          <form onSubmit={handleCreate} className="flex gap-2">
            <Input
              placeholder="Token name (e.g. shared-runner)"
              value={newTokenName}
              onChange={(e) => setNewTokenName(e.target.value)}
              className="max-w-xs"
            />
            <Button type="submit" size="sm" disabled={!newTokenName.trim() || creating}>
              {creating ? "Creating…" : "Create token"}
            </Button>
          </form>

          {tokens.length > 0 ? (
            <div className="space-y-1">
              {tokens.map((t) => (
                <div key={t.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm">
                  <div className="flex-1 min-w-0">
                    <span className="font-medium">{t.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      created {new Date(t.created_at).toLocaleDateString()}
                    </span>
                    {t.last_used_at && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        last used {new Date(t.last_used_at).toLocaleDateString()}
                      </span>
                    )}
                    {t.expires_at && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        expires {new Date(t.expires_at).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  {t.revoked_at ? (
                    <span className="text-xs text-muted-foreground">revoked</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void handleRevoke(t.id, t.name)}
                      className="text-muted-foreground hover:text-destructive"
                      aria-label={`Revoke ${t.name}`}
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No workspace tokens yet.</p>
          )}
        </>
      )}
    </section>
  );
}

type SectionKey = (typeof SETTINGS_NAV)[number]["key"];

const SECTION_KEYS = SETTINGS_NAV.map((item) => item.key);

function isValidSection(value: string | null): value is SectionKey {
  return value !== null && SECTION_KEYS.includes(value as SectionKey);
}

function sectionFromCandidate(value: string | null): SectionKey | null {
  const candidate =
    value === "api" ? "developer" :
    value === "slack" ? "channels" :
    value === "notifications" ? "channels" :
    value === "git" ? "developer" :
    value;
  return isValidSection(candidate) ? candidate : null;
}

export default function SettingsPage() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) {
    return <div className="p-6 text-sm text-muted-foreground">Loading settings...</div>;
  }
  return <SettingsContent />;
}

function SettingsContent() {
  const [search, setSearch] = useState(() =>
    typeof window !== "undefined" ? window.location.search : ""
  );
  const searchParams = useMemo(() => new URLSearchParams(search), [search]);
  const initialSection = (() => {
    const fromHash =
      typeof window !== "undefined" ? window.location.hash.replace(/^#/, "") : null;
    const fromQuery = searchParams.get("sel") || searchParams.get("tab");
    return sectionFromCandidate(fromQuery || fromHash);
  })();
  const [collectionState, setCollectionState] = useState<CollectionState>(() => ({
    ...emptyState("grid"),
    sel: initialSection,
  }));

  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [platformConfig, setPlatformConfig] = useState<PlatformConfig | null>(null);
  const [clearing, setClearing] = useState(false);
  const [claimedWhatsAppToken, setClaimedWhatsAppToken] = useState<string | null>(null);
  const [waClaimBanner, setWaClaimBanner] = useState<{ ok: boolean; message: string } | null>(null);
  const [claimedSlackToken, setClaimedSlackToken] = useState<string | null>(null);
  const [slackClaimBanner, setSlackClaimBanner] = useState<{ ok: boolean; message: string } | null>(null);
  // Federico 2026-06-11: a successful claim shows a full-screen confirmation,
  // not just an inline banner. Channel-aware copy; null = no overlay.
  const [claimSuccess, setClaimSuccess] = useState<ClaimChannel | null>(null);
  const [fromInstallChannel, setFromInstallChannel] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [workspaceList, setWorkspaceList] = useState<LocalWorkspaceListResponse | null>(null);
  const [isAdmin, setIsAdmin] = useState(true);

  useEffect(() => {
    void (async () => {
      try {
        const u = await api.me();
        setCurrentUser(u);
        setIsAdmin(u.is_admin ?? (u.role == null ? true : u.role === "admin" || u.role === "owner"));
      } catch {}
      try {
        setWorkspaceList(await api.workspace.list());
      } catch {}
    })();
  }, []);
  // PR S19 (I-44): type-to-confirm text for the Clear runs button.
  const [clearConfirmText, setClearConfirmText] = useState("");

  const loadData = useCallback(async () => {
    try {
      const [infoRes, platformRes] = await Promise.all([
        api.system.info(),
        api.system.platformConfig(),
      ]);
      setInfo(infoRes);
      setPlatformConfig(platformRes);
    } catch (e) {
      console.error(e);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const token = (searchParams.get("whatsapp_claim") || "").trim();
    if (!token || token === claimedWhatsAppToken) return;
    setClaimedWhatsAppToken(token);
    void (async () => {
      try {
        await api.whatsapp.claim(token);
        setClaimSuccess("whatsapp");
      } catch (e: unknown) {
        const raw = e instanceof Error ? e.message : "";
        const friendly =
          raw === "WhatsApp claim not found"
            ? "This link was not found or the number is already linked."
            : raw === "WhatsApp claim expired"
              ? "This link has expired. Text the Floom number again to get a new one."
              : raw || "Failed to link WhatsApp.";
        toast.error(friendly);
        setWaClaimBanner({ ok: false, message: friendly });
      } finally {
        const params = new URLSearchParams(searchParams.toString());
        params.delete("whatsapp_claim");
        const qs = params.size ? `?${params.toString()}` : "";
        const hash = typeof window !== "undefined" ? window.location.hash : "";
        const path = typeof window !== "undefined" ? window.location.pathname : "/settings";
        window.history.replaceState(null, "", `${path}${qs}${hash}`);
        setSearch(window.location.search);
      }
    })();
  }, [claimedWhatsAppToken, searchParams]);

  useEffect(() => {
    const token = (searchParams.get("slack_claim") || "").trim();
    if (!token || token === claimedSlackToken) return;
    setClaimedSlackToken(token);
    void (async () => {
      try {
        await api.slack.claim(token);
        setClaimSuccess("slack");
      } catch (e: unknown) {
        const raw = e instanceof Error ? e.message : "";
        const friendly =
          raw === "Slack claim not found"
            ? "This link was not found or the identity is already linked."
            : raw === "Slack claim expired"
              ? "This link has expired. Send Emily a DM in Slack to get a new one."
              : raw || "Failed to link Slack identity.";
        toast.error(friendly);
        setSlackClaimBanner({ ok: false, message: friendly });
      } finally {
        const params = new URLSearchParams(searchParams.toString());
        params.delete("slack_claim");
        const qs = params.size ? `?${params.toString()}` : "";
        const hash = typeof window !== "undefined" ? window.location.hash : "";
        const path = typeof window !== "undefined" ? window.location.pathname : "/settings";
        window.history.replaceState(null, "", `${path}${qs}${hash}`);
        setSearch(window.location.search);
      }
    })();
  }, [claimedSlackToken, searchParams]);

  // #552: consume ?from_install=<channel> placed by the login page after an
  // install-param sign-in, route to the relevant tab, show a banner.
  useEffect(() => {
    const channel = searchParams.get("from_install");
    if (!channel) return;
    setFromInstallChannel(channel);
    const tabMap: Record<string, SectionKey> = { slack: "channels", cli: "developer" };
    const dest = tabMap[channel];
    if (dest) setCollectionState((prev) => ({ ...prev, sel: dest, tab: null }));
    const params = new URLSearchParams(searchParams.toString());
    params.delete("from_install");
    params.delete("tab");
    if (dest) params.set("sel", dest);
    const qs = params.size ? `?${params.toString()}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${qs}`);
    setSearch(window.location.search);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep state in sync with ?sel= for deep-links/back-forward. Hash is accepted
  // only as a compatibility input for older links.
  useEffect(() => {
    function syncFromLocation() {
      const params = new URLSearchParams(window.location.search);
      const fromQuery = sectionFromCandidate(params.get("sel") || params.get("tab"));
      const raw = window.location.hash.replace(/^#/, "");
      const fromHash = sectionFromCandidate(raw);
      const nextSel = fromQuery || fromHash;
      if (nextSel) {
        setCollectionState((prev) => (prev.sel === nextSel ? prev : { ...prev, sel: nextSel, tab: null }));
      }
      setSearch(window.location.search);
    }
    window.addEventListener("hashchange", syncFromLocation);
    window.addEventListener("popstate", syncFromLocation);
    return () => {
      window.removeEventListener("hashchange", syncFromLocation);
      window.removeEventListener("popstate", syncFromLocation);
    };
  }, []);

  async function handleClearRuns() {
    if (clearConfirmText.trim() !== "DELETE ALL RUNS") return;
    setClearing(true);
    try {
      await api.system.clearRuns();
      toast.success("Run history cleared");
      setClearConfirmText("");
      void loadData();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to clear runs");
    } finally {
      setClearing(false);
    }
  }

  async function copySecretName(name: string) {
    try {
      await navigator.clipboard.writeText(name);
      toast.success(`Copied ${name}`);
    } catch {
      toast.error("Could not copy name");
    }
  }

  const workspaceName = resolveWorkspaceName(
    workspaceList?.workspaces.find((workspace) => workspace.id === workspaceList.active_id)?.name,
  );
  const accountName =
    currentUser?.display_name?.trim() ||
    currentUser?.email?.trim() ||
    currentUser?.username?.trim() ||
    "Federico";

  const config = useMemo<CollectionConfig<SettingsNavItemWithIcon>>(() => {
    const items = SETTINGS_NAV.map((item) => ({ ...item, icon: iconForSection(item.key) }));
    return {
      title: "Settings",
      subtitle: "Workspace settings and your account settings, kept separate.",
      items,
      idOf: (item) => item.key,
      searchOf: (item) => `${item.label} ${item.description} ${item.scope}`,
      tagsOf: (item) => ({ type: [item.scope] }),
      tags: {
        type: [
          { value: "workspace", label: "Workspace" },
          { value: "account", label: "Account" },
        ],
      },
      counts: [
        { value: settingsGroup("workspace").length, label: "workspace" },
        { value: settingsGroup("account").length, label: "account" },
      ],
      view: { default: "grid", grid: true },
      group: (item) =>
        item.scope === "workspace"
          ? groupLabel("workspace", workspaceName)
          : groupLabel("account", accountName),
      columns: { template: "1fr 24px", headers: ["Section", ""], statusColumn: false, menuColumn: false },
      row: (item) => ({
        leading: <SettingsIcon icon={item.icon} />,
        primary: item.label,
        secondary: item.description,
        cols: [<ChevronRight key="chevron" className="size-4 text-[var(--muted-foreground)]" />],
      }),
      card: (item) => ({
        leading: <SettingsIcon icon={item.icon} />,
        name: item.label,
        description: (
          <>
            {item.scope === "workspace" ? groupLabel("workspace", workspaceName) : groupLabel("account", accountName)}
            {" · "}
            {item.description}
          </>
        ),
        status: { tone: "idle", label: item.scope === "workspace" ? "Workspace" : "Account" },
      }),
      detail: (item) => ({
        header: {
          leading: <SettingsIcon icon={item.icon} />,
          title: item.label,
          sub: (
            <span>
              {item.scope === "workspace"
                ? groupLabel("workspace", workspaceName)
                : groupLabel("account", accountName)}
              {" · "}
              {item.description}
            </span>
          ),
        },
        tabs: [
          {
            key: "settings",
            label: item.label,
            render: () => renderSection(item.key),
          },
        ],
      }),
      states: {
        empty: { title: "No settings found" },
      },
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountName, clearConfirmText, clearing, info, isAdmin, platformConfig, workspaceName]);

  function handleCollectionChange(next: CollectionState) {
    setCollectionState(next);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tab");
    if (next.sel && isValidSection(next.sel)) params.set("sel", next.sel);
    else params.delete("sel");
    const qs = params.size ? `?${params.toString()}` : "";
    window.history.replaceState(null, "", `${window.location.pathname}${qs}`);
    setSearch(window.location.search);
  }

  function renderSection(key: SectionKey) {
    switch (key) {
      case "system":
        return (
          <SystemSection
            info={info}
            platformConfig={platformConfig}
            canEdit={isAdmin}
            onCopySecretName={copySecretName}
          />
        );
      case "channels":
        return <ChannelsTab canManageWorkspace={isAdmin} />;
      case "assistant":
        return <AssistantSettingsPanel canManageWorkspace={isAdmin} />;
      case "members":
        return <MembersSettingsPanel />;
      case "versions":
        return <VersionHistorySettingsPanel />;
      case "workspace_tokens":
        return <WorkspaceTokensPanel />;
      case "danger":
        return (
          <DangerSection
            canEdit={isAdmin}
            clearConfirmText={clearConfirmText}
            setClearConfirmText={setClearConfirmText}
            clearing={clearing}
            onClearRuns={handleClearRuns}
          />
        );
      case "developer":
        return (
          <DeveloperSection />
        );
      case "appearance":
        return <AppearanceSection />;
    }
  }

  return (
    <div className="space-y-6">
      {claimSuccess && (
        <ClaimSuccessOverlay
          channel={claimSuccess}
          onContinue={() => {
            setClaimSuccess(null);
            window.location.href = "/";
          }}
        />
      )}

      {waClaimBanner && (
        <Alert variant={waClaimBanner.ok ? "default" : "destructive"}>
          {waClaimBanner.ok ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <AlertTriangle className="size-4" />
          )}
          <AlertTitle>{waClaimBanner.ok ? "WhatsApp linked" : "WhatsApp link failed"}</AlertTitle>
          <AlertDescription>{waClaimBanner.message}</AlertDescription>
        </Alert>
      )}

      {slackClaimBanner && (
        <Alert variant={slackClaimBanner.ok ? "default" : "destructive"}>
          {slackClaimBanner.ok ? (
            <CheckCircle2 className="size-4" />
          ) : (
            <AlertTriangle className="size-4" />
          )}
          <AlertTitle>{slackClaimBanner.ok ? "Slack linked" : "Slack link failed"}</AlertTitle>
          <AlertDescription>{slackClaimBanner.message}</AlertDescription>
        </Alert>
      )}

      {fromInstallChannel && (
        <Alert>
          <AlertTitle>
            {fromInstallChannel === "slack" ? "Connect Slack to continue" :
             fromInstallChannel === "cli" ? "Get your CLI access token below" :
             `Complete your ${fromInstallChannel} setup`}
          </AlertTitle>
          <AlertDescription>
            {fromInstallChannel === "slack"
              ? "You were sent here from Slack. Add your workspace below to start using the assistant."
              : "Complete the setup for your channel integration."}
            {" "}
            <button
              type="button"
              className="underline underline-offset-2 hover:opacity-80"
              onClick={() => setFromInstallChannel(null)}
            >
              Dismiss
            </button>
          </AlertDescription>
        </Alert>
      )}

      <CollectionView
        config={config}
        state={collectionState}
        onChange={handleCollectionChange}
      />
    </div>
  );
}

type SettingsIconType = typeof Settings;
type SettingsNavItemWithIcon = (typeof SETTINGS_NAV)[number] & { icon: SettingsIconType };

function iconForSection(key: SectionKey): SettingsIconType {
  switch (key) {
    case "system":
      return Settings;
    case "channels":
      return MessageSquare;
    case "assistant":
      return Bot;
    case "members":
      return Users;
    case "versions":
      return History;
    case "workspace_tokens":
      return KeyRound;
    case "danger":
      return ShieldAlert;
    case "developer":
      return Code2;
    case "appearance":
      return Palette;
  }
}

function SettingsIcon({ icon: Icon }: { icon: SettingsIconType }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded-[var(--radius-button)] bg-[var(--bg-2)] text-[var(--ink-soft)]">
      <Icon className="size-4" />
    </span>
  );
}

function SystemSection({
  info,
  platformConfig,
  canEdit,
  onCopySecretName,
}: {
  info: SystemInfo | null;
  platformConfig: PlatformConfig | null;
  canEdit: boolean;
  onCopySecretName: (name: string) => Promise<void>;
}) {
  return (
    <div className="space-y-8">
      {!canEdit ? <ReadOnlyNotice /> : null}
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">System info</h2>
        <div className="space-y-2 text-sm">
          {info ? (
            <>
              <SystemInfoRow label="Version" value={info.version} mono />
              <SystemInfoRow label="Started at" value={info.started_at} mono />
              <SystemInfoRow label="Python" value={info.python_version} mono />
              <SystemInfoRow label="Runner" value={info.runner} />
            </>
          ) : (
            <div className="space-y-3">
              {[120, 96, 80].map((w, i) => (
                <div key={i} className="flex items-center justify-between">
                  <Skeleton className="h-4" style={{ width: 80 }} />
                  <Skeleton className="h-4" style={{ width: w }} />
                </div>
              ))}
            </div>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Workspace</h2>
        <WorkspaceInfoSettings canEdit={canEdit} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Behaviour</h2>
        <BehaviourSettings canEdit={canEdit} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Model defaults &amp; limits</h2>
        <ModelDefaults canEdit={canEdit} />
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">Platform configuration</h2>
        <div className="space-y-3">
          {!platformConfig ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            <>
              <div className="flex items-center justify-between rounded-[var(--radius-card)] bg-muted p-3">
                <span className="text-sm">Configured</span>
                <span className="text-sm font-medium">
                  {platformConfig.set_count}/{platformConfig.required_count}
                </span>
              </div>
              {platformConfig.all_required_set ? (
                <Alert>
                  <CheckCircle2 className="size-4" />
                  <AlertTitle>All required secrets are set</AlertTitle>
                  <AlertDescription>
                    Workers can run with full platform configuration.
                  </AlertDescription>
                </Alert>
              ) : (
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>
                    {platformConfig.missing.length} required{" "}
                    {platformConfig.missing.length === 1 ? "secret" : "secrets"} missing
                  </AlertTitle>
                  <AlertDescription>
                    <div className="mt-2 space-y-1.5">
                      {platformConfig.missing.map((name) => (
                        <div key={name} className="flex items-center justify-between gap-2">
                          <code className="text-xs">{name}</code>
                          <Button variant="outline" size="sm" onClick={() => void onCopySecretName(name)}>
                            Copy name
                          </Button>
                        </div>
                      ))}
                    </div>
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function SystemInfoRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 rounded-[var(--radius-card)] bg-[var(--bg-2)] px-3 py-3">
      <span className="text-muted-foreground">{label}</span>
      <span className={`min-w-0 break-words text-right font-medium ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

const MCP_INSTALL_SNIPPET = `{
  "mcpServers": {
    "floom": { "command": "npx", "args": ["-y", "@floomhq/workeros", "mcp"] }
  }
}`;

const CLI_INSTALL_SNIPPET = `npm i -g @floomhq/workeros
workeros login
workeros run <worker>`;

function CopyCodeCard({ title, description, value }: { title: string; description: string; value: string }) {
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      toast.success("Copied");
    } catch {
      toast.error("Could not copy");
    }
  }
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-medium">{title}</h2>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>
        <Button type="button" variant="outline" onClick={() => void copy()}>
          <Copy className="size-3.5" />
          Copy
        </Button>
      </div>
      <pre className="overflow-auto rounded-[var(--radius-button)] bg-[var(--bg-2)] p-3 font-mono text-xs text-[var(--ink-soft)]">
        {value}
      </pre>
    </div>
  );
}

function DeveloperSection() {
  return (
    <Tabs defaultValue="mcp">
      <TabsList>
        <TabsTrigger value="mcp">MCP</TabsTrigger>
        <TabsTrigger value="cli">CLI</TabsTrigger>
        <TabsTrigger value="tokens">Tokens</TabsTrigger>
        <TabsTrigger value="git">Git</TabsTrigger>
      </TabsList>
      <TabsContent value="mcp" className="space-y-4">
        <CopyCodeCard
          title="Agent install"
          description="Copy this into Claude Desktop, Cursor, VS Code, Windsurf, Cline, or any MCP client."
          value={MCP_INSTALL_SNIPPET}
        />
      </TabsContent>
      <TabsContent value="cli" className="space-y-4">
        <CopyCodeCard
          title="CLI install"
          description="Install the CLI, authenticate, and run a worker from your terminal."
          value={CLI_INSTALL_SNIPPET}
        />
      </TabsContent>
      <TabsContent value="tokens" className="space-y-4">
        <PersonalAccessTokensPanel />
      </TabsContent>
      <TabsContent value="git" className="space-y-4">
        <GitWorkspacePanel />
      </TabsContent>
    </Tabs>
  );
}

function AppearanceSection() {
  return (
    <div className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">Theme</h2>
      <p className="text-sm text-muted-foreground">
        Choose how Floom looks. System follows your operating system.
      </p>
      <ThemeModeToggleGroup />
    </div>
  );
}

function DangerSection({
  canEdit,
  clearConfirmText,
  setClearConfirmText,
  clearing,
  onClearRuns,
}: {
  canEdit: boolean;
  clearConfirmText: string;
  setClearConfirmText: (value: string) => void;
  clearing: boolean;
  onClearRuns: () => Promise<void>;
}) {
  if (!canEdit) {
    return <ReadOnlyNotice message="Danger actions are hidden because this account cannot perform workspace-destructive operations." />;
  }
  return (
    <div className="space-y-4">
      <section className="space-y-4">
        <div>
          <p className="text-sm font-medium text-destructive">Clear run history</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Deletes all runs, logs, artifacts, and approvals. Cannot be undone.
          </p>
        </div>
        <Label htmlFor="clear-runs-confirm" className="text-xs text-muted-foreground">
          Type <code className="text-foreground">DELETE ALL RUNS</code> to confirm.
        </Label>
        <Input
          id="clear-runs-confirm"
          value={clearConfirmText}
          onChange={(e) => setClearConfirmText(e.target.value)}
          placeholder="DELETE ALL RUNS"
          className="max-w-sm"
        />
        <Button
          variant="destructive"
          size="sm"
          className="shrink-0"
          onClick={() => void onClearRuns()}
          disabled={clearing || clearConfirmText.trim() !== "DELETE ALL RUNS"}
        >
          {clearing ? "Clearing..." : "Delete all runs"}
        </Button>
      </section>
    </div>
  );
}

function ReadOnlyNotice({ message = "Workspace controls are view only for this account." }: { message?: string }) {
  return (
    <Alert>
      <AlertTitle>View only</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

function ToggleRow({
  title,
  description,
  disabled,
  checked,
  onCheckedChange,
}: {
  title: string;
  description: string;
  disabled?: boolean;
  checked?: boolean;
  onCheckedChange?: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </div>
      <Switch disabled={disabled} checked={checked} onCheckedChange={onCheckedChange} />
      {disabled ? (
        <Badge variant="outline" className="text-xs">
          View only
        </Badge>
      ) : null}
    </div>
  );
}

// #794: workspace behaviour toggles, backed by the workspace-settings KV
// (admin-only writes — the server enforces #804). Members see them read-only.
const BEHAVIOUR_TOGGLES: { key: string; title: string; description: string }[] = [
  {
    key: "approval_default",
    title: "Require approval by default",
    description: "New workers pause for review before taking external actions.",
  },
  {
    // MUST be "auto_pause_enabled" — run_service._auto_pause_on_consecutive_
    // failures_enabled() reads exactly this key (the UI shipped writing
    // "auto_pause", which the runner never read — dead toggle).
    key: "auto_pause_enabled",
    title: "Auto-pause on repeated failures",
    description: "Pause a worker automatically after consecutive failed runs.",
  },
  {
    // Canonical key per #794's proposal; enforcement is tracked there.
    key: "failure_email_enabled",
    title: "Email me on run failures",
    description: "Send a notification when a run ends in error.",
  },
];

export function BehaviourSettings({ canEdit = true }: { canEdit?: boolean }) {
  return <BehaviourSettingsInner canEdit={canEdit} />;
}

function BehaviourSettingsInner({ canEdit }: { canEdit: boolean }) {
  const [values, setValues] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    api.workspace
      .getSettings()
      .then(setValues)
      .catch(() => setValues({}));
  }, []);

  const toggle = (key: string, next: boolean) => {
    if (!canEdit) return;
    setValues((prev) => ({ ...(prev ?? {}), [key]: next ? "true" : "false" }));
    api.workspace.setSetting(key, next ? "true" : "false").catch((err) => {
      toast.error((err as Error).message || "Could not save setting");
      // Re-sync from the server on failure.
      api.workspace.getSettings().then(setValues).catch(() => {});
    });
  };

  if (values === null) return <Skeleton className="h-24 w-full" />;
  return (
    <div className="space-y-4">
      {BEHAVIOUR_TOGGLES.map((t) => (
        <ToggleRow
          key={t.key}
          title={t.title}
          description={t.description}
          disabled={!canEdit}
          checked={values[t.key] === "true"}
          onCheckedChange={(v) => toggle(t.key, v)}
        />
      ))}
    </div>
  );
}


// #797: workspace model defaults & limits, persisted to the same workspace
// settings KV. Free-text/number inputs save on blur (admin-only writes; the
// server enforces #804).
const MODEL_DEFAULT_FIELDS: {
  key: string;
  label: string;
  placeholder: string;
  type: "text" | "number";
  hint: string;
}[] = [
  { key: "default_model", label: "Default model", placeholder: "e.g. claude-opus-4-8", type: "text", hint: "Used by new workers that don't pin a model." },
  { key: "max_output_tokens", label: "Max output tokens", placeholder: "e.g. 4096", type: "number", hint: "Per-run output ceiling." },
  { key: "spend_cap_usd", label: "Monthly spend cap (USD)", placeholder: "e.g. 100", type: "number", hint: "Soft cap for run costs this month." },
];

// #791: workspace region / timezone / company domain, persisted to the
// workspace settings KV (rename lives in the switcher).
const WORKSPACE_INFO_FIELDS: { key: string; label: string; placeholder: string; hint: string }[] = [
  { key: "region", label: "Region", placeholder: "e.g. us-east / eu-west", hint: "Where workers run (informational on OSS)." },
  { key: "timezone", label: "Timezone", placeholder: "e.g. America/New_York", hint: "Default timezone for schedules & display." },
  { key: "company_domain", label: "Company domain", placeholder: "e.g. acme.com", hint: "Used for the workspace logo." },
];

export function WorkspaceInfoSettings({ canEdit = true }: { canEdit?: boolean }) {
  const [values, setValues] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    api.workspace.getSettings().then(setValues).catch(() => setValues({}));
  }, []);

  const save = (key: string, value: string) => {
    if (!canEdit) return;
    api.workspace.setSetting(key, value).catch((err) => {
      toast.error((err as Error).message || "Could not save setting");
    });
  };

  if (values === null) return <Skeleton className="h-28 w-full" />;
  return (
    <div className="space-y-4">
      {WORKSPACE_INFO_FIELDS.map((f) => (
        <div key={f.key} className="space-y-1.5">
          <Label htmlFor={`ws-${f.key}`} className="text-sm">{f.label}</Label>
          <Input
            id={`ws-${f.key}`}
            defaultValue={values[f.key] ?? ""}
            placeholder={f.placeholder}
            className="max-w-xs"
            disabled={!canEdit}
            onBlur={(e) => {
              if (!canEdit) return;
              const v = e.target.value.trim();
              if (v !== (values[f.key] ?? "")) {
                setValues((prev) => ({ ...(prev ?? {}), [f.key]: v }));
                save(f.key, v);
              }
            }}
          />
          <p className="text-xs text-muted-foreground">{f.hint}</p>
        </div>
      ))}
    </div>
  );
}

export function ModelDefaults({ canEdit = true }: { canEdit?: boolean }) {
  const [values, setValues] = useState<Record<string, string> | null>(null);

  useEffect(() => {
    api.workspace.getSettings().then(setValues).catch(() => setValues({}));
  }, []);

  const save = (key: string, value: string) => {
    if (!canEdit) return;
    api.workspace.setSetting(key, value).catch((err) => {
      toast.error((err as Error).message || "Could not save setting");
    });
  };

  if (values === null) return <Skeleton className="h-28 w-full" />;
  return (
    <div className="space-y-4">
      {MODEL_DEFAULT_FIELDS.map((f) => (
        f.key === "default_model" ? (
          <div key={f.key} className="c-ltable">
            <div className="c-lrow" style={{ gridTemplateColumns: "1fr auto", cursor: "default" }}>
              <div className="c-lp-tx">
                <div className="nm">{f.label}</div>
                <div className="sub">{f.hint}</div>
              </div>
              <span className="c-vpill">{modelLabel(values[f.key])}</span>
            </div>
          </div>
        ) : (
        <div key={f.key} className="space-y-1.5">
          <Label htmlFor={`md-${f.key}`} className="text-sm">{f.label}</Label>
          <Input
            id={`md-${f.key}`}
            type={f.type}
            defaultValue={values[f.key] ?? ""}
            placeholder={f.placeholder}
            className="max-w-xs"
            disabled={!canEdit}
            onBlur={(e) => {
              if (!canEdit) return;
              const v = e.target.value.trim();
              if (v !== (values[f.key] ?? "")) {
                setValues((prev) => ({ ...(prev ?? {}), [f.key]: v }));
                save(f.key, v);
              }
            }}
          />
          <p className="text-xs text-muted-foreground">{f.hint}</p>
        </div>
        )
      ))}
    </div>
  );
}

function SettingsHistoryMenu({
  loadVersions,
  rollback,
  onRollback,
  refreshKey,
  confirmLabel,
  canRestore,
}: {
  loadVersions: () => Promise<VersionSummary[]>;
  rollback: (versionId: string) => Promise<string>;
  onRollback: (content: string) => void;
  refreshKey: number;
  confirmLabel: string;
  canRestore: boolean;
}) {
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [pendingRestore, setPendingRestore] = useState<VersionSummary | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setVersions(await loadVersions());
    } catch {
      setVersions([]);
    } finally {
      setLoading(false);
      setLoadedOnce(true);
    }
  }, [loadVersions]);

  useEffect(() => {
    if (loadedOnce) void refresh();
  }, [loadedOnce, refresh, refreshKey]);

  async function doRollback() {
    if (!pendingRestore) return;
    const v = pendingRestore;
    setPendingRestore(null);
    setRollingBack(v.id);
    try {
      const content = await rollback(v.id);
      onRollback(content);
      await refresh();
      toast.success(`Rolled back to version ${v.sha}`);
    } catch (e: unknown) {
      toast.error(`Rollback failed: ${e instanceof Error ? e.message : "unknown"}`);
    } finally {
      setRollingBack(null);
    }
  }

  return (
    <>
      <VersionHistoryMenu
        versions={versions}
        loading={loading && !loadedOnce}
        canRestore={canRestore}
        restoringId={rollingBack}
        onOpen={() => {
          if (!loadedOnce) void refresh();
        }}
        onRestore={(v) => setPendingRestore(v)}
      />
      <Dialog open={!!pendingRestore} onOpenChange={(open) => { if (!open) setPendingRestore(null); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Restore version {pendingRestore?.sha}?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            {confirmLabel} The current version is saved automatically before restoring.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingRestore(null)}>
              Cancel
            </Button>
            <Button onClick={() => void doRollback()}>
              Restore
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function AssistantSettingsPanel({ canManageWorkspace }: { canManageWorkspace: boolean }) {
  const [agent, setAgent] = useState<WorkspaceAgentInfo | null>(null);
  const [base, setBase] = useState("");
  const [originalBase, setOriginalBase] = useState("");
  const [baseIsCustom, setBaseIsCustom] = useState(false);
  const [editingBase, setEditingBase] = useState(false);
  const [savingBase, setSavingBase] = useState(false);
  const [resetConfirm, setResetConfirm] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [originalInstructions, setOriginalInstructions] = useState("");
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [versionsKey, setVersionsKey] = useState(0);
  const [baseVersionsKey, setBaseVersionsKey] = useState(0);

  const canEdit = canManageWorkspace && agent?.permissions?.can_edit !== false;
  const dirty = instructions !== originalInstructions;
  const baseDirty = base !== originalBase;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentRes, baseRes, instructionsRes] = await Promise.all([
        api.system.workspaceAgent(),
        api.system.workspaceBasePersona(),
        api.system.workspaceInstructions(),
      ]);
      setAgent(agentRes);
      setBase(baseRes.content);
      setOriginalBase(baseRes.content);
      setBaseIsCustom(baseRes.is_custom);
      setInstructions(instructionsRes);
      setOriginalInstructions(instructionsRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load workspace agent");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveBase() {
    if (!canEdit || !base.trim()) return;
    setSavingBase(true);
    try {
      await api.system.updateWorkspaceBasePersona(base);
      setOriginalBase(base);
      setBaseIsCustom(true);
      setEditingBase(false);
      setBaseVersionsKey((k) => k + 1);
      toast.success("Base instructions saved");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save base instructions");
    } finally {
      setSavingBase(false);
    }
  }

  async function saveInstructions() {
    if (!canEdit || !instructions.trim()) return;
    setSaving(true);
    try {
      await api.system.updateWorkspaceInstructions(instructions);
      setOriginalInstructions(instructions);
      setEditingInstructions(false);
      setVersionsKey((k) => k + 1);
      toast.success("Instructions saved");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save instructions");
    } finally {
      setSaving(false);
    }
  }

  async function resetBase() {
    if (!canEdit) return;
    setResetting(true);
    try {
      await api.system.resetWorkspaceBasePersona();
      setResetConfirm(false);
      setEditingBase(false);
      setBaseVersionsKey((k) => k + 1);
      toast.success("Base instructions reset to the built-in default");
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to reset base instructions");
    } finally {
      setResetting(false);
    }
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertTriangle className="size-4" />
        <AlertTitle>Couldn&apos;t load the assistant</AlertTitle>
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      {!canEdit ? <ReadOnlyNotice message="Assistant editing controls are hidden because this account cannot edit workspace assistant settings." /> : null}
      <div className="flex flex-wrap items-center gap-3">
        <EmilyAvatar size="md" />
        <div className="min-w-0">
          <h2 className="text-sm font-medium">Emily</h2>
          <p className="text-xs text-muted-foreground">Persona, workspace notes, and compiled prompt.</p>
        </div>
        {agent?.model ? <Badge variant="outline" className="text-xs">{modelLabel(agent.model)}</Badge> : null}
        {agent ? (
          <span className="ml-auto">
            <AssetVisibilityControl
              visibility={agent.visibility}
              canShare={canEdit && (agent.permissions?.can_share ?? true)}
              noun="Emily"
              titleLabel="Emily visibility"
              onApply={async (next) => {
                const updated = await api.system.setAssistantVisibility(next);
                setAgent(updated);
                return updated.visibility;
              }}
            />
          </span>
        ) : null}
      </div>

      <Tabs defaultValue="base">
        <TabsList>
          <TabsTrigger value="base">Persona</TabsTrigger>
          <TabsTrigger value="instructions">Workspace notes</TabsTrigger>
          <TabsTrigger value="prompt">Compiled prompt</TabsTrigger>
        </TabsList>
        <TabsContent value="base" className="space-y-3">
          {loading ? <Skeleton className="h-80 w-full" /> : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium">Emily persona</h3>
                    <Badge variant="outline" className="text-xs">{baseIsCustom ? "Custom" : "Built-in default"}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">Emily&apos;s core identity and style.</p>
                </div>
                <div className="flex items-center gap-2">
                  <SettingsHistoryMenu
                    refreshKey={baseVersionsKey}
                    loadVersions={() => api.system.listWorkspaceBaseVersions()}
                    rollback={(id) => api.system.rollbackWorkspaceBasePersona(id)}
                    onRollback={(content) => {
                      setBase(content);
                      setOriginalBase(content);
                      setBaseIsCustom(true);
                      setEditingBase(false);
                      setBaseVersionsKey((k) => k + 1);
                    }}
                    confirmLabel="This will overwrite your current base instructions."
                    canRestore={canEdit}
                  />
                  {editingBase ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => { setBase(originalBase); setEditingBase(false); }} disabled={savingBase}>
                        <X className="size-3.5" />
                        Cancel
                      </Button>
                      <Button size="sm" onClick={() => void saveBase()} disabled={!baseDirty || savingBase}>
                        <Save className="size-3.5" />
                        {savingBase ? "Saving" : "Save"}
                      </Button>
                    </>
                  ) : canEdit ? (
                    <>
                      {baseIsCustom ? (
                        <Button size="sm" variant="outline" onClick={() => setResetConfirm(true)} disabled={resetting}>
                          <RotateCcw className="size-3.5" />
                          Reset
                        </Button>
                      ) : null}
                      <Button size="sm" variant="outline" onClick={() => setEditingBase(true)}>Edit</Button>
                    </>
                  ) : null}
                </div>
              </div>
              <Textarea
                value={base}
                onChange={(event) => { if (editingBase) setBase(event.target.value); }}
                readOnly={!editingBase}
                className="min-h-[22rem] font-mono text-xs leading-relaxed read-only:bg-muted/40"
                spellCheck={false}
              />
            </>
          )}
        </TabsContent>
        <TabsContent value="instructions" className="space-y-3">
          {loading ? <Skeleton className="h-80 w-full" /> : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium">Workspace notes</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">Workspace-specific context and preferences.</p>
                </div>
                <div className="flex items-center gap-2">
                  <SettingsHistoryMenu
                    refreshKey={versionsKey}
                    loadVersions={() => api.system.listWorkspaceVersions()}
                    rollback={(id) => api.system.rollbackWorkspaceInstructions(id)}
                    onRollback={(content) => {
                      setInstructions(content);
                      setOriginalInstructions(content);
                      setEditingInstructions(false);
                      setVersionsKey((k) => k + 1);
                    }}
                    confirmLabel="This will overwrite your current workspace instructions."
                    canRestore={canEdit}
                  />
                  {editingInstructions ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => { setInstructions(originalInstructions); setEditingInstructions(false); }} disabled={saving}>
                        <X className="size-3.5" />
                        Cancel
                      </Button>
                      <Button size="sm" onClick={() => void saveInstructions()} disabled={!dirty || saving}>
                        <Save className="size-3.5" />
                        {saving ? "Saving" : "Save"}
                      </Button>
                    </>
                  ) : canEdit ? (
                    <Button size="sm" variant="outline" onClick={() => setEditingInstructions(true)}>Edit</Button>
                  ) : null}
                </div>
              </div>
              <Textarea
                value={instructions}
                onChange={(event) => { if (editingInstructions) setInstructions(event.target.value); }}
                readOnly={!editingInstructions}
                className="min-h-[22rem] font-mono text-xs leading-relaxed read-only:bg-muted/40"
                spellCheck={false}
              />
            </>
          )}
        </TabsContent>
        <TabsContent value="prompt" className="space-y-3">
          {loading || !agent ? <Skeleton className="h-96 w-full" /> : (
            <>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-medium">Compiled prompt</h3>
                  <p className="mt-0.5 text-xs text-muted-foreground">Read-only preview of Emily&apos;s full system prompt.</p>
                </div>
                <Badge variant="outline" className="text-xs">Read-only</Badge>
              </div>
              <pre className="max-h-[36rem] overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-button)] bg-muted/40 p-4 font-mono text-xs leading-relaxed text-foreground">
                {agent.system_prompt}
              </pre>
            </>
          )}
        </TabsContent>
      </Tabs>

      <Dialog open={resetConfirm} onOpenChange={(open) => { if (!open) setResetConfirm(false); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Reset base instructions?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            This removes your custom base instructions and restores the built-in default.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResetConfirm(false)} disabled={resetting}>Cancel</Button>
            <Button onClick={() => void resetBase()} disabled={resetting}>{resetting ? "Resetting" : "Reset to default"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

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
      {ROLE_LABEL[role]}
    </span>
  );
}

function looksLikeUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function memberLabel(m: WorkspaceMember, currentUser?: CurrentUser | null, isMe?: boolean): string {
  const fallbackUser =
    isMe
      ? currentUser?.display_name?.trim() || currentUser?.username?.trim() || currentUser?.email?.trim()
      : null;
  const label = m.display_name?.trim() || m.email?.trim() || fallbackUser || "";
  if (label) return label;
  return looksLikeUuid(m.user_id) ? "Workspace member" : m.user_id;
}

function memberInitial(m: WorkspaceMember, currentUser?: CurrentUser | null, isMe?: boolean): string {
  const base = memberLabel(m, currentUser, isMe);
  return base.slice(0, 2).toUpperCase();
}

function MembersSettingsPanel() {
  const [data, setData] = useState<WorkspaceMembersResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const [inviting, setInviting] = useState(false);
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [pendingAction, setPendingAction] = useState<
    | { kind: "remove"; member: WorkspaceMember }
    | { kind: "transfer"; member: WorkspaceMember }
    | null
  >(null);

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
    api.me().then(setCurrentUser).catch(() => setCurrentUser(null));
  }, [load]);

  const myRole = data?.my_role ?? null;
  const myMember = data?.members.find((m) => m.user_id === data.my_user_id) ?? null;
  const effectiveMyRole =
    myRole ??
    myMember?.role ??
    (currentUser?.is_admin || currentUser?.role === "admin" || currentUser?.role === "owner" ? "admin" : null);
  const canManage = effectiveMyRole === "owner" || effectiveMyRole === "admin";
  const isOwner = effectiveMyRole === "owner" || myMember?.role === "owner";
  const sortedMembers = data?.members ?? [];

  async function handleInvite(e: React.FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim();
    if (!email || inviting || !canManage) return;
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
    if (m.role === role || !isOwner) return;
    setBusyUser(m.user_id);
    try {
      await api.members.setRole(m.user_id, role);
      toast.success(`${memberLabel(m, currentUser, m.user_id === data?.my_user_id)} is now ${ROLE_LABEL[role]}`);
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

  if (!data && !error) return <Skeleton className="h-48 w-full" />;

  return (
    <div className="space-y-6">
      {error ? (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Couldn&apos;t load members</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {!canManage ? <ReadOnlyNotice message="Member management controls are hidden because this account is not Owner or Admin." /> : null}

      {canManage ? (
        <form onSubmit={handleInvite} className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-[var(--bg-2)] p-4 sm:flex-row sm:items-center">
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
          <div className="inline-flex rounded-[var(--radius-button)] bg-[var(--bg-card)] p-0.5">
            {(["member", "admin"] as const).map((role) => (
              <button
                key={role}
                type="button"
                className={cn(
                  "h-8 px-3 text-sm",
                  inviteRole === role ? "rounded-[var(--radius-button)] bg-[var(--bg-2)] text-foreground" : "text-muted-foreground",
                )}
                onClick={() => setInviteRole(role)}
              >
                {ROLE_LABEL[role]}
              </button>
            ))}
          </div>
          <Button type="submit" disabled={!inviteEmail.trim() || inviting}>
            {inviting ? "Inviting..." : "Invite"}
          </Button>
        </form>
      ) : null}

      <div className="space-y-1">
        {sortedMembers.map((m) => {
          const isMe = m.user_id === data?.my_user_id;
          const isBusy = busyUser === m.user_id;
          const canChangeRole = isOwner && m.role !== "owner" && !isMe;
          const canRemove =
            canManage &&
            m.role !== "owner" &&
            !isMe &&
            !(effectiveMyRole === "admin" && m.role === "admin");
          const canTransfer = isOwner && m.role !== "owner" && m.status === "active";
          return (
            <div key={m.user_id} className="flex flex-wrap items-center gap-3 [border-bottom:var(--bd-div)] py-3 last:[border-bottom:0]">
              <div className="grid size-9 shrink-0 place-items-center rounded-[var(--radius-button)] bg-[var(--bg-2)] text-[11px] font-medium text-foreground">
                {memberInitial(m, currentUser, isMe)}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium text-foreground">{memberLabel(m, currentUser, isMe)}</span>
                  {isMe ? <span className="text-[11px] text-[var(--ink-mute)]">You</span> : null}
                </div>
                {m.email && m.email !== memberLabel(m, currentUser, isMe) ? (
                  <p className="truncate text-xs text-[var(--ink-mute)]">{m.email}</p>
                ) : null}
              </div>
              {m.status === "invited" ? (
                <span className="rounded-[var(--radius-pill)] bg-[var(--bg-2)] px-2 py-0.5 text-[11px] text-[var(--ink-mute)]">
                  Invited
                </span>
              ) : null}
              <RoleBadge role={m.role} />
              {canChangeRole ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={isBusy}
                  onClick={() => void handleSetRole(m, m.role === "member" ? "admin" : "member")}
                >
                  Make {m.role === "member" ? "admin" : "member"}
                </Button>
              ) : null}
              {canTransfer ? (
                <Button size="sm" variant="ghost" disabled={isBusy} onClick={() => setPendingAction({ kind: "transfer", member: m })}>
                  Transfer
                </Button>
              ) : null}
              {canRemove ? (
                <Button size="sm" variant="ghost" className="text-destructive" disabled={isBusy} onClick={() => setPendingAction({ kind: "remove", member: m })}>
                  Remove
                </Button>
              ) : null}
            </div>
          );
        })}
        {sortedMembers.length === 0 ? (
          <div className="py-8 text-center text-sm text-[var(--ink-mute)]">No members yet.</div>
        ) : null}
      </div>

      <Dialog open={!!pendingAction} onOpenChange={(open) => { if (!open) setPendingAction(null); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {pendingAction?.kind === "transfer" ? "Transfer ownership?" : "Remove member?"}
            </DialogTitle>
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

function VersionHistorySettingsPanel() {
  const [workspaceVersions, setWorkspaceVersions] = useState<VersionSummary[] | null>(null);
  const [baseVersions, setBaseVersions] = useState<VersionSummary[] | null>(null);

  useEffect(() => {
    void (async () => {
      const [workspace, base] = await Promise.allSettled([
        api.system.listWorkspaceVersions(),
        api.system.listWorkspaceBaseVersions(),
      ]);
      setWorkspaceVersions(workspace.status === "fulfilled" ? workspace.value : []);
      setBaseVersions(base.status === "fulfilled" ? base.value : []);
    })();
  }, []);

  return (
    <div className="space-y-6">
      <Alert>
        <AlertTitle>Workspace changelog</AlertTitle>
        <AlertDescription>
          Merged multi-asset timeline is tracked as #772; this view shows the built workspace instruction histories.
        </AlertDescription>
      </Alert>
      <VersionList title="Workspace notes" versions={workspaceVersions} />
      <VersionList title="Base persona" versions={baseVersions} />
    </div>
  );
}

function VersionList({ title, versions }: { title: string; versions: VersionSummary[] | null }) {
  return (
    <section className="space-y-3">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {versions === null ? (
        <Skeleton className="h-24 w-full" />
      ) : versions.length === 0 ? (
        <p className="text-sm text-muted-foreground">No commits yet.</p>
      ) : (
        <div className="space-y-1">
          {versions.map((v, index) => (
            <div key={`${v.asset_type}-${v.id}-${index}`} className="flex items-center justify-between gap-3 [border-bottom:var(--bd-div)] py-2 text-sm last:[border-bottom:0]">
              <div className="min-w-0">
                <p className="truncate font-medium">{v.message}</p>
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">{v.sha}</span> · {v.author} · {new Date(v.timestamp).toLocaleString()}
                </p>
              </div>
              {index === 0 ? <Badge variant="outline">Current</Badge> : null}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// SPEC §12: Channels — how you reach Emily/workers (inbound), set once.
// Slack (live), WhatsApp (coming), and "install in your agent" over MCP/CLI.
// ---------------------------------------------------------------------------
// WhatsApp QR — static inline SVG generated from the fixed wa.me deep-link.
// No external service, no npm dep. The QR data was generated offline with
// qrcode (Python) for https://wa.me/16503999709 at error-correction M.
// To regenerate: python3 -c "import qrcode; ..." (see git history for script).
// ---------------------------------------------------------------------------
const WA_BOT_NUMBER = "16503999709";
const WA_LINK = `https://wa.me/${WA_BOT_NUMBER}`;

// Pre-computed QR path for WA_LINK (29×29 modules, 2-module border).
const WA_QR_PATH =
  "M2,2h1v1h-1z M3,2h1v1h-1z M4,2h1v1h-1z M5,2h1v1h-1z M6,2h1v1h-1z M7,2h1v1h-1z M8,2h1v1h-1z M15,2h1v1h-1z M18,2h1v1h-1z M20,2h1v1h-1z M21,2h1v1h-1z M22,2h1v1h-1z M23,2h1v1h-1z M24,2h1v1h-1z M25,2h1v1h-1z M26,2h1v1h-1z M2,3h1v1h-1z M8,3h1v1h-1z M10,3h1v1h-1z M11,3h1v1h-1z M12,3h1v1h-1z M13,3h1v1h-1z M18,3h1v1h-1z M20,3h1v1h-1z M26,3h1v1h-1z M2,4h1v1h-1z M4,4h1v1h-1z M5,4h1v1h-1z M6,4h1v1h-1z M8,4h1v1h-1z M10,4h1v1h-1z M12,4h1v1h-1z M13,4h1v1h-1z M17,4h1v1h-1z M18,4h1v1h-1z M20,4h1v1h-1z M22,4h1v1h-1z M23,4h1v1h-1z M24,4h1v1h-1z M26,4h1v1h-1z M2,5h1v1h-1z M4,5h1v1h-1z M5,5h1v1h-1z M6,5h1v1h-1z M8,5h1v1h-1z M10,5h1v1h-1z M12,5h1v1h-1z M15,5h1v1h-1z M16,5h1v1h-1z M20,5h1v1h-1z M22,5h1v1h-1z M23,5h1v1h-1z M24,5h1v1h-1z M26,5h1v1h-1z M2,6h1v1h-1z M4,6h1v1h-1z M5,6h1v1h-1z M6,6h1v1h-1z M8,6h1v1h-1z M11,6h1v1h-1z M12,6h1v1h-1z M16,6h1v1h-1z M20,6h1v1h-1z M22,6h1v1h-1z M23,6h1v1h-1z M24,6h1v1h-1z M26,6h1v1h-1z M2,7h1v1h-1z M8,7h1v1h-1z M11,7h1v1h-1z M12,7h1v1h-1z M15,7h1v1h-1z M20,7h1v1h-1z M26,7h1v1h-1z M2,8h1v1h-1z M3,8h1v1h-1z M4,8h1v1h-1z M5,8h1v1h-1z M6,8h1v1h-1z M7,8h1v1h-1z M8,8h1v1h-1z M10,8h1v1h-1z M12,8h1v1h-1z M14,8h1v1h-1z M16,8h1v1h-1z M18,8h1v1h-1z M20,8h1v1h-1z M21,8h1v1h-1z M22,8h1v1h-1z M23,8h1v1h-1z M24,8h1v1h-1z M25,8h1v1h-1z M26,8h1v1h-1z M10,9h1v1h-1z M12,9h1v1h-1z M13,9h1v1h-1z M14,9h1v1h-1z M16,9h1v1h-1z M17,9h1v1h-1z M18,9h1v1h-1z M2,10h1v1h-1z M8,10h1v1h-1z M10,10h1v1h-1z M11,10h1v1h-1z M14,10h1v1h-1z M15,10h1v1h-1z M17,10h1v1h-1z M18,10h1v1h-1z M19,10h1v1h-1z M20,10h1v1h-1z M23,10h1v1h-1z M24,10h1v1h-1z M25,10h1v1h-1z M2,11h1v1h-1z M4,11h1v1h-1z M6,11h1v1h-1z M7,11h1v1h-1z M10,11h1v1h-1z M13,11h1v1h-1z M14,11h1v1h-1z M15,11h1v1h-1z M17,11h1v1h-1z M18,11h1v1h-1z M21,11h1v1h-1z M22,11h1v1h-1z M23,11h1v1h-1z M24,11h1v1h-1z M25,11h1v1h-1z M2,12h1v1h-1z M4,12h1v1h-1z M5,12h1v1h-1z M7,12h1v1h-1z M8,12h1v1h-1z M9,12h1v1h-1z M10,12h1v1h-1z M12,12h1v1h-1z M13,12h1v1h-1z M14,12h1v1h-1z M17,12h1v1h-1z M18,12h1v1h-1z M20,12h1v1h-1z M21,12h1v1h-1z M22,12h1v1h-1z M23,12h1v1h-1z M25,12h1v1h-1z M26,12h1v1h-1z M2,13h1v1h-1z M5,13h1v1h-1z M6,13h1v1h-1z M10,13h1v1h-1z M13,13h1v1h-1z M16,13h1v1h-1z M19,13h1v1h-1z M20,13h1v1h-1z M21,13h1v1h-1z M23,13h1v1h-1z M26,13h1v1h-1z M6,14h1v1h-1z M7,14h1v1h-1z M8,14h1v1h-1z M9,14h1v1h-1z M12,14h1v1h-1z M14,14h1v1h-1z M16,14h1v1h-1z M17,14h1v1h-1z M19,14h1v1h-1z M20,14h1v1h-1z M26,14h1v1h-1z M2,15h1v1h-1z M6,15h1v1h-1z M7,15h1v1h-1z M9,15h1v1h-1z M11,15h1v1h-1z M15,15h1v1h-1z M16,15h1v1h-1z M17,15h1v1h-1z M21,15h1v1h-1z M25,15h1v1h-1z M2,16h1v1h-1z M4,16h1v1h-1z M8,16h1v1h-1z M9,16h1v1h-1z M13,16h1v1h-1z M14,16h1v1h-1z M17,16h1v1h-1z M18,16h1v1h-1z M19,16h1v1h-1z M21,16h1v1h-1z M22,16h1v1h-1z M23,16h1v1h-1z M25,16h1v1h-1z M26,16h1v1h-1z M2,17h1v1h-1z M4,17h1v1h-1z M6,17h1v1h-1z M9,17h1v1h-1z M12,17h1v1h-1z M13,17h1v1h-1z M17,17h1v1h-1z M21,17h1v1h-1z M23,17h1v1h-1z M24,17h1v1h-1z M26,17h1v1h-1z M2,18h1v1h-1z M5,18h1v1h-1z M8,18h1v1h-1z M11,18h1v1h-1z M12,18h1v1h-1z M13,18h1v1h-1z M14,18h1v1h-1z M15,18h1v1h-1z M18,18h1v1h-1z M19,18h1v1h-1z M20,18h1v1h-1z M21,18h1v1h-1z M22,18h1v1h-1z M24,18h1v1h-1z M10,19h1v1h-1z M12,19h1v1h-1z M14,19h1v1h-1z M15,19h1v1h-1z M16,19h1v1h-1z M18,19h1v1h-1z M22,19h1v1h-1z M2,20h1v1h-1z M3,20h1v1h-1z M4,20h1v1h-1z M5,20h1v1h-1z M6,20h1v1h-1z M7,20h1v1h-1z M8,20h1v1h-1z M11,20h1v1h-1z M13,20h1v1h-1z M15,20h1v1h-1z M16,20h1v1h-1z M18,20h1v1h-1z M20,20h1v1h-1z M22,20h1v1h-1z M26,20h1v1h-1z M2,21h1v1h-1z M8,21h1v1h-1z M14,21h1v1h-1z M16,21h1v1h-1z M18,21h1v1h-1z M22,21h1v1h-1z M25,21h1v1h-1z M26,21h1v1h-1z M2,22h1v1h-1z M4,22h1v1h-1z M5,22h1v1h-1z M6,22h1v1h-1z M8,22h1v1h-1z M11,22h1v1h-1z M12,22h1v1h-1z M13,22h1v1h-1z M15,22h1v1h-1z M17,22h1v1h-1z M18,22h1v1h-1z M19,22h1v1h-1z M20,22h1v1h-1z M21,22h1v1h-1z M22,22h1v1h-1z M24,22h1v1h-1z M2,23h1v1h-1z M4,23h1v1h-1z M5,23h1v1h-1z M6,23h1v1h-1z M8,23h1v1h-1z M13,23h1v1h-1z M14,23h1v1h-1z M17,23h1v1h-1z M18,23h1v1h-1z M19,23h1v1h-1z M20,23h1v1h-1z M25,23h1v1h-1z M26,23h1v1h-1z M2,24h1v1h-1z M4,24h1v1h-1z M5,24h1v1h-1z M6,24h1v1h-1z M8,24h1v1h-1z M14,24h1v1h-1z M15,24h1v1h-1z M16,24h1v1h-1z M23,24h1v1h-1z M24,24h1v1h-1z M26,24h1v1h-1z M2,25h1v1h-1z M8,25h1v1h-1z M11,25h1v1h-1z M12,25h1v1h-1z M14,25h1v1h-1z M16,25h1v1h-1z M18,25h1v1h-1z M19,25h1v1h-1z M21,25h1v1h-1z M22,25h1v1h-1z M26,25h1v1h-1z M2,26h1v1h-1z M3,26h1v1h-1z M4,26h1v1h-1z M5,26h1v1h-1z M6,26h1v1h-1z M7,26h1v1h-1z M8,26h1v1h-1z M10,26h1v1h-1z M11,26h1v1h-1z M13,26h1v1h-1z M16,26h1v1h-1z M18,26h1v1h-1z M20,26h1v1h-1z M23,26h1v1h-1z M26,26h1v1h-1z";

function WhatsAppQR() {
  return (
    <div className="flex flex-col items-center gap-2">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 29 29"
        width={120}
        height={120}
        shapeRendering="crispEdges"
        aria-label="WhatsApp QR code"
        role="img"
        className="rounded-[var(--radius-button)] [border:var(--bd-card)]"
      >
        <rect width="29" height="29" fill="white" />
        <path fill="black" d={WA_QR_PATH} />
      </svg>
      <a
        href={WA_LINK}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-muted-foreground hover:text-foreground underline underline-offset-2"
      >
        +1 650-399-9709
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// SlackBindingStatus — per-user DM identity status + unlink
// ---------------------------------------------------------------------------
function SlackBindingStatus() {
  const [binding, setBinding] = useState<import("@/lib/types").SlackBindingMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [unlinking, setUnlinking] = useState(false);

  const load = useCallback(async () => {
    try {
      setBinding(await api.slack.bindingMe());
    } catch {
      // endpoint may not exist on older engines — fail silently
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleUnlink() {
    if (!confirm("Unlink your Slack identity from this account?")) return;
    setUnlinking(true);
    try {
      await api.slack.unlink();
      toast.success("Slack identity unlinked");
      void load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to unlink Slack");
    } finally {
      setUnlinking(false);
    }
  }

  if (loading) return <Skeleton className="h-8 w-48" />;
  if (!binding) return null;
  if (!binding.linked) {
    return (
      <p className="text-xs text-muted-foreground">
        DM Emily in Slack to link your identity.
      </p>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] bg-muted/40 px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground truncate">
          {binding.profile_name
            ? `${binding.profile_name} (${binding.slack_user_id})`
            : binding.slack_user_id}
        </p>
        <p className="text-[11px] text-muted-foreground">Team {binding.slack_team_id}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => void handleUnlink()}
        disabled={unlinking}
      >
        {unlinking ? "Unlinking..." : "Unlink"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WhatsAppBindingStatus — per-user binding status + unlink
// ---------------------------------------------------------------------------
function WhatsAppBindingStatus() {
  const [binding, setBinding] = useState<import("@/lib/types").WhatsAppBindingMe | null>(null);
  const [loading, setLoading] = useState(true);
  const [unlinking, setUnlinking] = useState(false);

  const load = useCallback(async () => {
    try {
      setBinding(await api.whatsapp.bindingMe());
    } catch {
      // endpoint may not exist on older engines — fail silently
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  async function handleUnlink() {
    if (!confirm("Unlink your WhatsApp number from this account?")) return;
    setUnlinking(true);
    try {
      await api.whatsapp.unlink();
      toast.success("WhatsApp number unlinked");
      void load();
    } catch (e: unknown) {
      toast.error(e instanceof Error ? e.message : "Failed to unlink WhatsApp");
    } finally {
      setUnlinking(false);
    }
  }

  if (loading) return <Skeleton className="h-8 w-48" />;
  if (!binding) return null;
  if (!binding.linked) {
    return (
      <p className="text-xs text-muted-foreground">
        Scan the QR or text the number above, then tap the link Emily sends you.
      </p>
    );
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-[var(--radius-button)] bg-muted/40 px-3 py-2">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground truncate">
          {binding.profile_name
            ? `${binding.profile_name} (${binding.wa_id_masked})`
            : binding.wa_id_masked}
        </p>
        <p className="text-[11px] text-muted-foreground">Linked to this account</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="shrink-0 text-muted-foreground hover:text-destructive"
        onClick={() => void handleUnlink()}
        disabled={unlinking}
      >
        {unlinking ? "Unlinking..." : "Unlink"}
      </Button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChannelsTab — Slack + WhatsApp + Agent install
// ---------------------------------------------------------------------------
function ChannelsTab({ canManageWorkspace }: { canManageWorkspace: boolean }) {
  const [qrOpen, setQrOpen] = useState(false);
  return (
    <div className="space-y-4">
      <Tabs defaultValue="slack">
        <TabsList>
          <TabsTrigger value="slack">Slack</TabsTrigger>
          <TabsTrigger value="email">Email</TabsTrigger>
          <TabsTrigger value="whatsapp">WhatsApp</TabsTrigger>
        </TabsList>
        <TabsContent value="slack" className="space-y-4">
          <div className="c-ltable">
            <div className="c-lrow" style={{ gridTemplateColumns: "1fr auto", cursor: "default" }}>
              <div className="c-lp-tx">
                <div className="nm">Slack workspace</div>
                <div className="sub">Add Emily to Slack, then DM her to link your identity.</div>
              </div>
              {canManageWorkspace ? (
                <SlackConnect />
              ) : (
                <span className="c-vpill">View only</span>
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Your link status</p>
            <SlackBindingStatus />
          </div>
        </TabsContent>
        <TabsContent value="email" className="space-y-4">
          <div className="c-ltable">
            <div className="c-lrow" style={{ gridTemplateColumns: "1fr auto", cursor: "default" }}>
              <div className="c-lp-tx">
                <div className="nm">Email</div>
                <div className="sub">Email channel setup is not connected for this workspace yet.</div>
              </div>
              <span className="c-vpill">Not connected</span>
            </div>
          </div>
        </TabsContent>
        <TabsContent value="whatsapp" className="space-y-4">
          <div className="c-ltable">
            <div className="c-lrow" style={{ gridTemplateColumns: "1fr auto", cursor: "default" }}>
              <div className="c-lp-tx">
                <div className="nm">WhatsApp</div>
                <div className="sub">Scan the QR code to start a chat and bind your number.</div>
              </div>
              <Button type="button" variant="outline" onClick={() => setQrOpen(true)}>
                <QrCode className="size-3.5" />
                Show QR
              </Button>
            </div>
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Your link status</p>
            <WhatsAppBindingStatus />
          </div>
        </TabsContent>
      </Tabs>
      <Dialog open={qrOpen} onOpenChange={setQrOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Link WhatsApp</DialogTitle>
            <DialogDescription>Scan this QR code, send Emily a message, then open the claim link she replies with.</DialogDescription>
          </DialogHeader>
          <WhatsAppQR />
        </DialogContent>
      </Dialog>
    </div>
  );
}
