"use client";

import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState } from "react";
import { Trash2, Plus, ShieldCheck } from "lucide-react";

export function SecretsTab() {
  const secrets = useQuery(api.secrets.list);
  const upsert = useMutation(api.secrets.upsert);
  const remove = useMutation(api.secrets.remove);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved">("idle");
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !value.trim()) return;
    setStatus("saving");
    try {
      await upsert({ name: name.trim().toUpperCase(), value: value.trim() });
      setName("");
      setValue(""); // clear value immediately — never display it again
      setStatus("saved");
      setTimeout(() => setStatus("idle"), 2000);
    } catch {
      setStatus("idle");
    }
  };

  const handleDelete = async (secretName: string) => {
    await remove({ name: secretName });
    setDeleteConfirm(null);
  };

  return (
    <div className="p-4 max-w-lg">
      <div className="flex items-center gap-2 mb-4">
        <ShieldCheck size={16} className="text-gray-500" />
        <h3 className="text-sm font-medium text-gray-700">Org Secrets</h3>
      </div>
      <p className="text-xs text-gray-500 mb-4">
        Secrets are encrypted and shared across all automations in your org.
        Values are never visible after saving.
      </p>

      {/* Add secret form */}
      <form onSubmit={handleSubmit} className="border border-gray-200 rounded p-3 mb-4 space-y-3">
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Name <span className="text-gray-400">(e.g. ANTHROPIC_API_KEY)</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="SECRET_NAME"
            className="w-full px-3 py-2 border border-gray-300 rounded text-sm font-mono focus:outline-none focus:ring-1 focus:ring-blue-500"
            required
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-gray-600 mb-1">
            Value
          </label>
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="••••••••"
            className="w-full px-3 py-2 border border-gray-300 rounded text-sm focus:outline-none focus:ring-1 focus:ring-blue-500"
            required
          />
        </div>
        <button
          type="submit"
          disabled={status === "saving" || !name.trim() || !value.trim()}
          className="flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          <Plus size={14} />
          {status === "saving" ? "Saving..." : status === "saved" ? "Saved!" : "Save Secret"}
        </button>
      </form>

      {/* Secret list */}
      {secrets === undefined ? (
        <div className="text-sm text-gray-400 animate-pulse">Loading...</div>
      ) : secrets.length === 0 ? (
        <p className="text-xs text-gray-400">No secrets stored yet.</p>
      ) : (
        <ul className="space-y-1">
          {secrets.map((s) => (
            <li
              key={s.name}
              className="flex items-center justify-between px-3 py-2 border border-gray-200 rounded text-sm"
            >
              <div>
                <span className="font-mono text-gray-800 text-xs">{s.name}</span>
                <span className="ml-3 text-gray-400 text-xs">••••••••</span>
              </div>
              {deleteConfirm === s.name ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-red-600">Delete?</span>
                  <button
                    onClick={() => handleDelete(s.name)}
                    className="text-xs text-red-600 hover:text-red-800 font-medium"
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setDeleteConfirm(null)}
                    className="text-xs text-gray-500 hover:text-gray-700"
                  >
                    No
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setDeleteConfirm(s.name)}
                  className="text-gray-400 hover:text-red-500 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
