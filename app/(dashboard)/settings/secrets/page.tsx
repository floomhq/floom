"use client";

import { useQuery, useMutation, useConvex } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useState } from "react";
import { Copy, Check, Eye, EyeOff, Pencil, MinusCircle, Undo2 } from "lucide-react";

export default function SecretsPage() {
  const convex = useConvex();
  const secrets = useQuery(api.secrets.list);
  const upsert = useMutation(api.secrets.upsert);
  const remove = useMutation(api.secrets.remove);

  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");

  // Per-secret UI state
  const [visibleSecrets, setVisibleSecrets] = useState<Set<string>>(new Set());
  const [decryptedValues, setDecryptedValues] = useState<Record<string, string>>({});
  const [editingSecret, setEditingSecret] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editValue, setEditValue] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [copiedSecret, setCopiedSecret] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  async function fetchDecryptedValue(secretName: string): Promise<string | null> {
    if (decryptedValues[secretName]) return decryptedValues[secretName];
    try {
      const value = await convex.query(api.secrets.getDecryptedValue, { name: secretName });
      setDecryptedValues((prev) => ({ ...prev, [secretName]: value }));
      return value;
    } catch {
      return null;
    }
  }

  async function toggleVisibility(secretName: string) {
    if (visibleSecrets.has(secretName)) {
      setVisibleSecrets((prev) => {
        const next = new Set(prev);
        next.delete(secretName);
        return next;
      });
    } else {
      await fetchDecryptedValue(secretName);
      setVisibleSecrets((prev) => new Set(prev).add(secretName));
    }
  }

  async function handleCopy(secretName: string) {
    const val = await fetchDecryptedValue(secretName);
    if (!val) return;
    await navigator.clipboard.writeText(val);
    setCopiedSecret(secretName);
    setTimeout(() => setCopiedSecret(null), 2000);
  }

  async function startEdit(secretName: string) {
    const val = await fetchDecryptedValue(secretName);
    setEditingSecret(secretName);
    setEditName(secretName);
    setEditValue(val ?? "");
  }

  function cancelEdit() {
    setEditingSecret(null);
    setEditName("");
    setEditValue("");
  }

  async function saveEdit() {
    if (!editName.trim() || !editValue.trim() || !editingSecret) return;
    setEditSaving(true);
    try {
      // If name changed, remove old and create new
      if (editName.trim() !== editingSecret) {
        await remove({ name: editingSecret });
      }
      await upsert({ name: editName.trim().toUpperCase(), value: editValue.trim() });
      // Update cached decrypted value
      setDecryptedValues((prev) => {
        const next = { ...prev };
        delete next[editingSecret!];
        next[editName.trim().toUpperCase()] = editValue.trim();
        return next;
      });
      setEditingSecret(null);
      setEditName("");
      setEditValue("");
    } catch {
      // keep editing open on error
    } finally {
      setEditSaving(false);
    }
  }

  async function handleDelete(secretName: string) {
    setConfirmDelete(null);
    await remove({ name: secretName });
    setDecryptedValues((prev) => {
      const next = { ...prev };
      delete next[secretName];
      return next;
    });
    setVisibleSecrets((prev) => {
      const next = new Set(prev);
      next.delete(secretName);
      return next;
    });
  }

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

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-sm font-semibold text-gray-700 mb-0.5">
          Workspace Secrets
        </h2>
        <p className="text-xs text-gray-500">
          View and configure environment variables for your workspace.
        </p>
      </div>

      {/* Existing secrets */}
      {secrets === undefined && (
        <div className="animate-pulse space-y-2">
          {[1, 2].map((i) => (
            <div key={i} className="h-12 bg-gray-100 rounded" />
          ))}
        </div>
      )}

      {secrets !== undefined && secrets.length === 0 && (
        <p className="text-xs text-gray-400">No secrets saved yet.</p>
      )}

      {secrets !== undefined && secrets.length > 0 && (
        <div>
          {/* Table header */}
          <div className="grid grid-cols-[1fr_1fr_auto] gap-4 px-3 py-2 text-xs text-gray-500 border-b border-gray-200">
            <span>Name</span>
            <span>Value</span>
            <span className="w-24" />
          </div>

          {/* Rows */}
          <div className="divide-y divide-gray-100">
            {secrets.map((secret) => (
              <div key={secret.name}>
                {editingSecret === secret.name ? (
                  /* Edit mode */
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-4 items-center px-3 py-3">
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value.toUpperCase())}
                      className="px-3 py-2 border border-gray-300 rounded text-sm font-mono bg-gray-50 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <input
                      type="text"
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      className="px-3 py-2 border border-gray-300 rounded text-sm bg-gray-50 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={saveEdit}
                        disabled={editSaving || !editName.trim() || !editValue.trim()}
                        className="px-3 py-1.5 bg-blue-600 text-white rounded text-xs font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
                      >
                        {editSaving ? "Saving..." : "Save"}
                      </button>
                      <button
                        onClick={cancelEdit}
                        className="flex items-center gap-1 px-3 py-1.5 border border-gray-200 rounded text-xs text-gray-600 hover:bg-gray-50 transition-colors"
                      >
                        <Undo2 size={12} />
                        Undo Edit
                      </button>
                    </div>
                  </div>
                ) : (
                  /* Display mode */
                  <div className="grid grid-cols-[1fr_1fr_auto] gap-4 items-center px-3 py-3 min-w-0">
                    <span className="text-sm font-mono font-medium text-gray-800 truncate">
                      {secret.name}
                    </span>
                    <div className="flex items-center gap-2 min-w-0">
                      <button
                        onClick={() => toggleVisibility(secret.name)}
                        className="text-gray-400 hover:text-gray-600 transition-colors shrink-0"
                        title={visibleSecrets.has(secret.name) ? "Hide value" : "Show value"}
                      >
                        {visibleSecrets.has(secret.name) ? <EyeOff size={16} /> : <Eye size={16} />}
                      </button>
                      <span className="text-sm text-gray-600 font-mono min-w-0 break-all">
                        {visibleSecrets.has(secret.name) && decryptedValues[secret.name]
                          ? decryptedValues[secret.name]
                          : "••••••••••••••"}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={() => startEdit(secret.name)}
                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                        title="Edit"
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        onClick={() => handleCopy(secret.name)}
                        className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors"
                        title="Copy value"
                      >
                        {copiedSecret === secret.name ? (
                          <Check size={14} className="text-emerald-500" />
                        ) : (
                          <Copy size={14} />
                        )}
                      </button>
                      <button
                        onClick={() => setConfirmDelete(secret.name)}
                        className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 rounded transition-colors"
                        title="Delete"
                      >
                        <MinusCircle size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
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

      {/* Delete confirmation dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-lg shadow-lg p-6 max-w-sm w-full mx-4">
            <h3 className="text-sm font-semibold text-gray-900 mb-2">
              Delete secret
            </h3>
            <p className="text-sm text-gray-600 mb-4">
              Are you sure you want to delete{" "}
              <code className="font-mono bg-gray-100 px-1 py-0.5 rounded text-xs">
                {confirmDelete}
              </code>
              ? This action cannot be undone.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setConfirmDelete(null)}
                className="px-3 py-1.5 border border-gray-200 rounded text-sm text-gray-600 hover:bg-gray-50 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDelete(confirmDelete)}
                className="px-3 py-1.5 bg-red-600 text-white rounded text-sm font-medium hover:bg-red-700 transition-colors"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
