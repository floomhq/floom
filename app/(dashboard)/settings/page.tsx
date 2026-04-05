"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState, useEffect } from "react";
import { Nav } from "@/components/Nav";
import { Trash2, Copy, Check, Key, Terminal, Plus, Ban } from "lucide-react";
import { Id } from "@/convex/_generated/dataModel";

type SettingsSection = "api-key" | "secrets";

export default function SettingsPage() {
  const [section, setSection] = useState<SettingsSection>("api-key");

  const sections = [
    { id: "api-key" as const, label: "API Key" },
    { id: "secrets" as const, label: "Workspace Secrets" },
  ];

  return (
    <div className="min-h-screen bg-white flex flex-col">
      <Nav />
      <div className="max-w-4xl mx-auto w-full px-4 py-6 flex-1">
        <h1 className="text-lg font-semibold text-gray-900 mb-6">Settings</h1>
        <div className="flex gap-6">
          {/* Sidebar nav */}
          <nav className="w-40 shrink-0">
            <ul className="space-y-1">
              {sections.map((s) => (
                <li key={s.id}>
                  <button
                    onClick={() => setSection(s.id)}
                    className={`w-full text-left px-3 py-2 rounded text-sm transition-colors ${
                      section === s.id
                        ? "bg-gray-100 text-gray-900 font-medium"
                        : "text-gray-600 hover:text-gray-900"
                    }`}
                  >
                    {s.label}
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {/* Content */}
          <div className="flex-1 min-w-0">
            {section === "api-key" && <ApiKeySection />}
            {section === "secrets" && <SecretsSection />}
          </div>
        </div>
      </div>
    </div>
  );
}

function ApiKeySection() {
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
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">API Keys</h2>
        <p className="text-xs text-gray-500 mb-3">
          Org-scoped keys to authenticate the{" "}
          <code className="font-mono bg-gray-100 px-1 py-0.5 rounded text-xs">
            floom
          </code>{" "}
          Claude Code skill.
        </p>

        {/* New key banner */}
        {newKeyValue && (
          <div className="mb-4 p-3 bg-emerald-50 border border-emerald-200 rounded">
            <p className="text-xs text-emerald-800 font-medium mb-1">
              New API key created. Copy it now -- it will not be shown again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 text-xs font-mono text-emerald-900 bg-emerald-100 px-2 py-1 rounded truncate">
                {newKeyValue}
              </code>
              <button
                onClick={copyNewKey}
                className="flex items-center gap-1 px-2 py-1 bg-white border border-emerald-200 rounded text-xs text-emerald-700 hover:bg-emerald-50"
              >
                {copiedNewKey ? (
                  <Check size={11} className="text-emerald-500" />
                ) : (
                  <Copy size={11} />
                )}
                {copiedNewKey ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {/* Existing keys list */}
        {keys && keys.length > 0 && (
          <div className="divide-y divide-gray-100 border border-gray-200 rounded mb-4">
            {keys.map((k) => (
              <div
                key={k._id}
                className="flex items-center justify-between px-3 py-2.5"
              >
                <div className="flex items-center gap-3">
                  <Key size={14} className="text-gray-400" />
                  <div>
                    <span className="text-sm text-gray-700 font-medium">
                      {k.name}
                    </span>
                    <span className="text-xs text-gray-400 ml-2 font-mono">
                      {k.prefix}...
                    </span>
                    {k.revokedAt && (
                      <span className="text-xs text-red-500 ml-2">Revoked</span>
                    )}
                  </div>
                </div>
                {!k.revokedAt && (
                  <button
                    onClick={() => revokeKey({ keyId: k._id })}
                    className="text-gray-400 hover:text-red-500 transition-colors"
                    title="Revoke key"
                  >
                    <Ban size={14} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Create key form */}
        <form onSubmit={handleCreate} className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Key name (e.g. dev-laptop)"
            value={keyName}
            onChange={(e) => setKeyName(e.target.value)}
            className="flex-1 px-3 py-2 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={creating || !keyName.trim() || !orgId}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            <Plus size={14} />
            {creating ? "Creating..." : "Create key"}
          </button>
        </form>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">
          Install Skill
        </h2>
        <p className="text-xs text-gray-500 mb-3">
          Run this in your terminal to install floom in Claude Code:
        </p>
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center gap-2 border border-gray-200 rounded px-3 py-2 bg-gray-50">
            <Terminal size={14} className="text-gray-400 shrink-0" />
            <code className="text-xs font-mono text-gray-700 truncate">
              {installCommand}
            </code>
          </div>
          <button
            onClick={copyInstall}
            className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            {copiedInstall ? (
              <Check size={14} className="text-emerald-500" />
            ) : (
              <Copy size={14} />
            )}
            {copiedInstall ? "Copied!" : "Copy"}
          </button>
        </div>
      </section>
    </div>
  );
}

function SecretsSection() {
  const secrets = useQuery(api.secrets.list);
  const upsert = useMutation(api.secrets.upsert);
  const remove = useMutation(api.secrets.remove);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [deletingName, setDeletingName] = useState<string | null>(null);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !value.trim()) return;
    setSaving(true);
    setSaveError("");
    try {
      await upsert({ name: name.trim().toUpperCase(), value: value.trim() });
      setName("");
      setValue("");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(secretName: string) {
    setDeletingName(secretName);
    try {
      await remove({ name: secretName });
    } finally {
      setDeletingName(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-0.5">
          Workspace Secrets
        </h2>
        <p className="text-xs text-gray-500">
          Shared with your entire workspace. Never shown after saving.
        </p>
      </div>

      {/* Existing secrets */}
      {secrets === undefined && (
        <div className="animate-pulse space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-10 bg-gray-100 rounded" />
          ))}
        </div>
      )}

      {secrets !== undefined && secrets.length === 0 && (
        <p className="text-xs text-gray-400">No secrets saved yet.</p>
      )}

      {secrets !== undefined && secrets.length > 0 && (
        <div className="divide-y divide-gray-100 border border-gray-200 rounded">
          {secrets.map((secret) => (
            <div
              key={secret.name}
              className="flex items-center justify-between px-3 py-2.5"
            >
              <div>
                <span className="text-sm font-mono text-gray-700">
                  {secret.name}
                </span>
                <span className="text-xs text-gray-400 ml-3">
                  {new Date(secret.createdAt).toLocaleDateString("en-US", {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </div>
              <button
                onClick={() => handleDelete(secret.name)}
                disabled={deletingName === secret.name}
                className="text-gray-400 hover:text-red-500 transition-colors disabled:opacity-50"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add secret form */}
      <form onSubmit={handleAdd} className="space-y-2">
        <h3 className="text-xs font-medium text-gray-600">Add secret</h3>
        <div className="flex items-center gap-2">
          <input
            type="text"
            placeholder="Name (e.g. ANTHROPIC_API_KEY)"
            value={name}
            onChange={(e) => setName(e.target.value.toUpperCase())}
            className="flex-1 px-3 py-2 border border-gray-200 rounded text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <input
            type="password"
            placeholder="Value"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            className="flex-1 px-3 py-2 border border-gray-200 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <button
            type="submit"
            disabled={saving || !name.trim() || !value.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            {saving ? "Saving..." : "Add"}
          </button>
        </div>
        {saveError && <p className="text-xs text-red-500">{saveError}</p>}
      </form>
    </div>
  );
}
