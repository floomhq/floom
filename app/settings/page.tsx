"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState, useEffect } from "react";
import { Nav } from "@/components/Nav";
import { Trash2, Copy, Check, RefreshCw, Key, Terminal } from "lucide-react";

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
  const [copied, setCopied] = useState(false);
  const [copiedInstall, setCopiedInstall] = useState(false);
  const [copiedConfig, setCopiedConfig] = useState(false);

  const apiKey = useQuery(api.users.getApiKey);
  const generateApiKey = useMutation(api.users.generateApiKey);

  const [origin, setOrigin] = useState("https://yourplatform.com");
  useEffect(() => { setOrigin(window.location.origin); }, []);

  const convexUrl = process.env.NEXT_PUBLIC_CONVEX_URL ?? "";
  const platformUrl = convexUrl.replace(".cloud", ".site");
  const installCommand = `curl -s ${origin}/install-skill.sh | bash -s -- ${origin}`;
  const configJson = apiKey
    ? JSON.stringify({ api_key: apiKey, platform_url: platformUrl }, null, 2)
    : null;

  async function copyKey() {
    if (!apiKey) return;
    await navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  async function copyInstall() {
    await navigator.clipboard.writeText(installCommand);
    setCopiedInstall(true);
    setTimeout(() => setCopiedInstall(false), 2000);
  }

  async function copyConfig() {
    if (!configJson) return;
    await navigator.clipboard.writeText(configJson);
    setCopiedConfig(true);
    setTimeout(() => setCopiedConfig(false), 2000);
  }

  return (
    <div className="space-y-6">
      <section>
        <h2 className="text-sm font-semibold text-gray-700 mb-1">API Key</h2>
        <p className="text-xs text-gray-500 mb-3">
          Use this to authenticate the{" "}
          <code className="font-mono bg-gray-100 px-1 py-0.5 rounded text-xs">
            floom
          </code>{" "}
          Claude Code skill.
        </p>
        {apiKey ? (
          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center gap-2 border border-gray-200 rounded px-3 py-2 bg-gray-50 font-mono text-sm">
              <Key size={14} className="text-gray-400 shrink-0" />
              <span className="text-gray-700 truncate">
                {apiKey.slice(0, 12)}••••••••••••••••••••••••
              </span>
            </div>
            <button
              onClick={copyKey}
              className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              {copied ? <Check size={14} className="text-emerald-500" /> : <Copy size={14} />}
              {copied ? "Copied!" : "Copy"}
            </button>
          </div>
        ) : (
          <button
            onClick={() => generateApiKey()}
            className="flex items-center gap-1.5 px-3 py-2 border border-gray-200 rounded text-sm text-gray-700 bg-white hover:bg-gray-50 transition-colors"
          >
            <Key size={14} />
            Generate API key
          </button>
        )}
        {apiKey && (
          <div className="mt-2 flex items-center gap-2">
            <button
              onClick={() => generateApiKey()}
              className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700"
            >
              <RefreshCw size={12} />
              Regenerate key
            </button>
            <span className="text-xs text-red-500">
              ⚠ Regenerating invalidates the old key.
            </span>
          </div>
        )}
      </section>

      {apiKey && configJson && (
        <section>
          <h2 className="text-sm font-semibold text-gray-700 mb-1">Quick Setup</h2>
          <p className="text-xs text-gray-500 mb-3">
            Paste this into your terminal to configure the skill in one step:
          </p>
          <div className="relative">
            <pre className="bg-gray-50 border border-gray-200 rounded px-3 py-2 text-xs font-mono text-gray-700 overflow-x-auto">{`cat > ~/.claude/floom-config.json << 'EOF'\n${configJson}\nEOF`}</pre>
            <button
              onClick={copyConfig}
              className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 bg-white border border-gray-200 rounded text-xs text-gray-500 hover:bg-gray-50"
            >
              {copiedConfig ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
              {copiedConfig ? "Copied!" : "Copy"}
            </button>
          </div>
        </section>
      )}

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
        <h2 className="text-sm font-semibold text-gray-700 mb-0.5">Workspace Secrets</h2>
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
        {saveError && (
          <p className="text-xs text-red-500">{saveError}</p>
        )}
      </form>
    </div>
  );
}
