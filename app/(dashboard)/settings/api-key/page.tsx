"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState, useEffect } from "react";
import { Copy, Check, Key, Terminal, Plus, Ban } from "lucide-react";
import { Id } from "@/convex/_generated/dataModel";

export default function ApiKeyPage() {
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
