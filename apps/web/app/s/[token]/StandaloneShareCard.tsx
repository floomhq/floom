"use client";

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, Download, FileText, Layers, Package, RotateCcw } from "lucide-react";
import { BrandLogo } from "@/components/connections/BrandLogo";
import type { PublicShareFile, StandaloneShare } from "@/lib/types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function entityLabel(type: StandaloneShare["entity_type"]): string {
  if (type === "worker") return "Worker";
  if (type === "brain_file") return "Brain file";
  return "Brain pack";
}

function previewText(share: StandaloneShare): string {
  if (share.entity_type === "worker") {
    const worker = share.worker;
    if (worker?.example_output) return worker.example_output;
    if (worker?.how_it_works) return worker.how_it_works;
    if (worker?.use_cases?.length) return worker.use_cases.join("\n");
    return worker?.description || "This worker is shared as a read-only card.";
  }
  return share.file?.content_text || "Preview is unavailable. Use the file list to inspect available files.";
}

function fileTitle(file?: PublicShareFile | null, entityType?: StandaloneShare["entity_type"]): string {
  if (entityType === "worker") return "WORKER PREVIEW";
  if (!file) return "PREVIEW";
  const base = file.path.split("/").pop() || file.path;
  return `${base.toUpperCase()} PREVIEW`;
}

function previewLabel(files: StandaloneShare["files"]): string {
  if (files.length > 0) return `Preview all ${files.length} file${files.length === 1 ? "" : "s"} before installing`;
  return "Preview details";
}

// Layered stack icon matching Floom's share mark
function ShareIconTile({ type }: { type: StandaloneShare["entity_type"] }) {
  if (type === "brain_pack") {
    return (
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 10,
          border: "1px solid #e2e2e0",
          background: "#f0f0ee",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#555",
        }}
      >
        <Package size={22} />
      </div>
    );
  }
  if (type === "brain_file") {
    return (
      <div
        style={{
          width: 48,
          height: 48,
          borderRadius: 10,
          border: "1px solid #e2e2e0",
          background: "#f0f0ee",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "#555",
        }}
      >
        <FileText size={22} />
      </div>
    );
  }
  // Worker: layered stack mark like Floom's package/share icon
  return (
    <div
      style={{
        width: 48,
        height: 48,
        borderRadius: 10,
        border: "1px solid #e2e2e0",
        background: "#f0f0ee",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "#444",
      }}
    >
      {/* SVG approximating Floom's layered stack/share icon */}
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2L2 7l10 5 10-5-10-5z" />
        <path d="M2 17l10 5 10-5" />
        <path d="M2 12l10 5 10-5" />
      </svg>
    </div>
  );
}

// Sender avatar: initials or "W"
function SenderAvatar({ name }: { name?: string }) {
  const initials = name
    ? name.trim().split(/\s+/).slice(0, 2).map((w) => w[0].toUpperCase()).join("")
    : "W";
  return (
    <span
      style={{
        display: "grid",
        placeItems: "center",
        width: 32,
        height: 32,
        minWidth: 32,
        borderRadius: "50%",
        background: "#e8e8e5",
        fontSize: 11,
        fontWeight: 600,
        color: "#333",
        letterSpacing: 0,
        flexShrink: 0,
      }}
    >
      {initials}
    </span>
  );
}

// Share-specific neutral surface palette — overrides the app's warm beige
const SHARE_VARS = {
  "--s-bg": "#f5f5f3",
  "--s-card": "#ffffff",
  "--s-surface": "#f0f0ee",
  "--s-border": "#e2e2e0",
  "--s-border-soft": "#eaeae8",
  "--s-ink": "#141414",
  "--s-ink-soft": "#6b6b68",
  "--s-ink-mute": "#9c9c98",
  "--s-mono": '"Geist Mono", "SF Mono", ui-monospace, monospace',
} as React.CSSProperties;

export function StandaloneShareCard({ share, token }: { share: StandaloneShare; token: string }) {
  const [copied, setCopied] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);
  const [showFiles, setShowFiles] = useState(false);
  const [activePath, setActivePath] = useState(share.file?.path || share.files[0]?.path || "");
  const [shareUrl, setShareUrl] = useState(`/s/${token}`);
  const activeFile = useMemo(
    () => share.files.find((file) => file.path === activePath) || share.file || share.files[0] || null,
    [activePath, share.file, share.files],
  );
  const text = previewText(share);
  const worker = share.worker;
  const files = share.files || [];
  const isWorker = share.entity_type === "worker";
  const isFile = share.entity_type === "brain_file";

  // The install command uses the token directly, not the full URL
  const installCmd = `npx -y @floomhq/floom add ${token}`;

  const primaryHref =
    isWorker && worker?.id
      ? `/workers/${encodeURIComponent(worker.id)}`
      : share.entity_type === "brain_pack"
        ? "/contexts"
        : `/s/${encodeURIComponent(token)}/download`;
  const primaryLabel =
    isWorker
      ? "Run this worker"
      : share.entity_type === "brain_pack"
        ? "View pack"
        : "Download file";

  useEffect(() => {
    setShareUrl(window.location.href);
  }, []);

  async function copyShareLink() {
    await navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  async function copyInstallCmd() {
    await navigator.clipboard.writeText(installCmd);
    setCopiedCmd(true);
    window.setTimeout(() => setCopiedCmd(false), 1500);
  }

  // Sender info — PublicWorker has no owner_name; fall back to generic label
  const senderName: string | undefined = undefined;

  return (
    <main
      style={{
        minHeight: "calc(100vh - 56px)",
        padding: "40px 12px 40px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        background: "var(--s-bg, #f5f5f3)",
        ...SHARE_VARS,
      }}
    >
      <div style={{ width: "min(452px, 100%)" }}>
        <section
          style={{
            position: "relative",
            overflow: "hidden",
            borderRadius: 13,
            border: "1px solid var(--s-border)",
            background: "var(--s-card)",
            boxShadow: "0 16px 36px hsl(0 0% 0% / 0.10), 0 0 0 1px var(--s-border)",
          }}
        >
          {!showFiles ? (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {/* Sender strip */}
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                  borderBottom: "1px solid var(--s-border-soft)",
                  background: "var(--s-surface)",
                  padding: "14px 20px",
                }}
              >
                <SenderAvatar name={senderName} />
                <div style={{ minWidth: 0, fontSize: 12.5, lineHeight: 1.5 }}>
                  <strong style={{ display: "block", fontWeight: 600, color: "var(--s-ink)" }}>
                    {senderName ? `${senderName} shared this with you` : "A Workeros operator shared this with you"}
                  </strong>
                  <span style={{ color: "var(--s-ink-soft)" }}>
                    Shared via Workeros
                  </span>
                </div>
              </div>

              {/* Content area */}
              <div style={{ display: "flex", flexDirection: "column", padding: "20px 24px" }}>
                {/* Shared via link badge */}
                <div style={{ marginBottom: 16 }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      borderRadius: 999,
                      border: "1px solid var(--s-border)",
                      background: "var(--s-card)",
                      padding: "4px 10px",
                      fontFamily: "var(--s-mono)",
                      fontSize: 11,
                      color: "var(--s-ink-soft)",
                    }}
                  >
                    <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#2f8f5b", flexShrink: 0 }} />
                    Shared via link
                  </span>
                </div>

                {/* Icon tile */}
                <div style={{ marginBottom: 12 }}>
                  <ShareIconTile type={share.entity_type} />
                </div>

                {/* Breadcrumb — brain_file only: Brain / <pack name> / <filename> */}
                {isFile && (
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 4,
                      marginBottom: 8,
                      fontFamily: "var(--s-mono)",
                      fontSize: 11,
                      color: "var(--s-ink-mute)",
                      flexWrap: "wrap",
                    }}
                  >
                    <span>Brain</span>
                    <span>/</span>
                    <span>{share.pack?.name ?? "Pack"}</span>
                    <span>/</span>
                    <span style={{ color: "var(--s-ink-soft)" }}>{share.title}</span>
                  </div>
                )}

                {/* Title */}
                <h1
                  style={{
                    margin: "0 0 8px 0",
                    fontSize: 26,
                    fontWeight: 600,
                    lineHeight: 1.15,
                    color: "var(--s-ink)",
                    letterSpacing: "-0.01em",
                  }}
                >
                  {share.title}
                </h1>

                {/* Description */}
                {share.description && (
                  <p
                    style={{
                      margin: "0 0 16px 0",
                      fontSize: 13.5,
                      lineHeight: 1.6,
                      color: "var(--s-ink-soft)",
                    }}
                  >
                    {share.description}
                  </p>
                )}

                {/* Connection pills — for worker */}
                {worker?.connections && worker.connections.length > 0 && (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
                    {worker.connections.map((slug) => (
                      <span
                        key={slug}
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: 5,
                          borderRadius: 7,
                          border: "1px solid var(--s-border)",
                          background: "var(--s-surface)",
                          padding: "4px 8px",
                          fontSize: 11,
                          color: "var(--s-ink-soft)",
                        }}
                      >
                        <BrandLogo icon={slug} className="size-3.5" />
                        {slug.replace(/[-_]/g, " ")}
                      </span>
                    ))}
                  </div>
                )}

                {/* Preview toggle button — matches reference "Preview all N files before installing" */}
                <button
                  type="button"
                  onClick={() => setShowFiles(true)}
                  style={{
                    marginBottom: 8,
                    display: "flex",
                    width: "100%",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 12,
                    borderRadius: 7,
                    border: "1px solid var(--s-border)",
                    background: "var(--s-surface)",
                    padding: "9px 12px",
                    textAlign: "left",
                    fontFamily: "var(--s-mono)",
                    fontSize: 11,
                    color: "var(--s-ink)",
                    cursor: "pointer",
                  }}
                >
                  <span>{previewLabel(files)}</span>
                  <RotateCcw size={13} style={{ color: "var(--s-ink-mute)", flexShrink: 0 }} />
                </button>

                {/* Preview block */}
                <div
                  style={{
                    overflow: "hidden",
                    borderRadius: 9,
                    border: "1px solid var(--s-border)",
                    background: "var(--s-surface)",
                    marginBottom: 20,
                  }}
                >
                  <div
                    style={{
                      borderBottom: "1px solid var(--s-border-soft)",
                      padding: "7px 12px",
                      fontFamily: "var(--s-mono)",
                      fontSize: 10,
                      textTransform: "uppercase" as const,
                      letterSpacing: "0.04em",
                      color: "var(--s-ink-mute)",
                    }}
                  >
                    {fileTitle(activeFile, share.entity_type)}
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      maxHeight: 140,
                      overflow: "hidden",
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-word",
                      padding: "10px 12px",
                      fontFamily: "var(--s-mono)",
                      fontSize: 11,
                      lineHeight: 1.6,
                      color: "var(--s-ink-soft)",
                    }}
                  >
                    {text}
                  </pre>
                </div>

                {/* CTA section */}
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {/* Primary action — "Copy install command" for skills/packs, or "Run this worker" / "Download" */}
                  {isWorker || share.entity_type === "brain_pack" ? (
                    <button
                      type="button"
                      onClick={copiedCmd ? undefined : copyInstallCmd}
                      style={{
                        display: "inline-flex",
                        height: 44,
                        width: "100%",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 8,
                        borderRadius: 9,
                        border: "none",
                        background: "#141414",
                        padding: "0 16px",
                        fontSize: 14,
                        fontWeight: 500,
                        color: "#ffffff",
                        cursor: "pointer",
                        letterSpacing: "-0.01em",
                      }}
                    >
                      {copiedCmd ? <Check size={16} /> : <Copy size={16} />}
                      {copiedCmd ? "Copied!" : "Copy install command"}
                    </button>
                  ) : (
                    <a
                      href={primaryHref}
                      style={{
                        display: "inline-flex",
                        height: 44,
                        width: "100%",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 8,
                        borderRadius: 9,
                        border: "none",
                        background: "#141414",
                        padding: "0 16px",
                        fontSize: 14,
                        fontWeight: 500,
                        color: "#ffffff",
                        textDecoration: "none",
                        letterSpacing: "-0.01em",
                      }}
                    >
                      <Download size={16} />
                      {primaryLabel}
                    </a>
                  )}

                  {/* Command/link artifact */}
                  <code
                    style={{
                      display: "block",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      borderRadius: 7,
                      border: "1px solid var(--s-border)",
                      background: "var(--s-surface)",
                      padding: "9px 12px",
                      fontFamily: "var(--s-mono)",
                      fontSize: 11,
                      color: "var(--s-ink-soft)",
                    }}
                  >
                    {isWorker || share.entity_type === "brain_pack" ? installCmd : shareUrl}
                  </code>

                  {/* Secondary links row */}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 8,
                    }}
                  >
                    {(isWorker || share.entity_type === "brain_pack") && (
                      <>
                        <span style={{ fontFamily: "var(--s-mono)", fontSize: 10.5, color: "var(--s-ink-mute)" }}>
                          Install into one agent only?
                        </span>
                        <button
                          type="button"
                          onClick={() => {}}
                          style={{
                            background: "none",
                            border: "none",
                            padding: 0,
                            cursor: "pointer",
                            fontFamily: "var(--s-mono)",
                            fontSize: 10.5,
                            color: "var(--s-ink-soft)",
                            textDecoration: "underline",
                          }}
                        >
                          Show options
                        </button>
                      </>
                    )}
                    {isFile && (
                      <button
                        type="button"
                        onClick={copyShareLink}
                        style={{
                          display: "inline-flex",
                          height: 32,
                          alignItems: "center",
                          justifyContent: "center",
                          gap: 6,
                          borderRadius: 7,
                          border: "1px solid var(--s-border)",
                          background: "var(--s-card)",
                          padding: "0 12px",
                          fontFamily: "var(--s-mono)",
                          fontSize: 11,
                          color: "var(--s-ink-soft)",
                          cursor: "pointer",
                        }}
                      >
                        {copied ? <Check size={13} /> : <Copy size={13} />}
                        {copied ? "Copied" : "Copy share link"}
                      </button>
                    )}
                  </div>

                  {/* No account note */}
                  {(isWorker || share.entity_type === "brain_pack") && (
                    <p
                      style={{
                        margin: 0,
                        fontFamily: "var(--s-mono)",
                        fontSize: 10.5,
                        color: "var(--s-ink-mute)",
                        lineHeight: 1.5,
                      }}
                    >
                      <strong style={{ fontWeight: 600, color: "var(--s-ink-soft)" }}>No account needed.</strong>{" "}
                      Paste the command into your Claude project.
                    </p>
                  )}
                </div>

                {/* Footer */}
                <div
                  style={{
                    marginTop: 20,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    paddingTop: 8,
                    fontFamily: "var(--s-mono)",
                    fontSize: 11,
                    color: "var(--s-ink-mute)",
                  }}
                >
                  <span>{entityLabel(share.entity_type)}</span>
                  <button
                    type="button"
                    onClick={() => setShowFiles(true)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 5,
                      borderRadius: 5,
                      border: "none",
                      background: "none",
                      padding: "4px 8px",
                      fontFamily: "var(--s-mono)",
                      fontSize: 11,
                      color: "var(--s-ink-soft)",
                      cursor: "pointer",
                    }}
                  >
                    Inspect content
                    <Layers size={13} />
                  </button>
                </div>
              </div>
            </div>
          ) : (
            /* File inspector panel */
            <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 600 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  borderBottom: "1px solid var(--s-border-soft)",
                  padding: "12px 20px",
                }}
              >
                <span
                  style={{
                    fontFamily: "var(--s-mono)",
                    fontSize: 11,
                    textTransform: "uppercase" as const,
                    letterSpacing: "0.04em",
                    color: "var(--s-ink-mute)",
                  }}
                >
                  What is inside / {files.length || 1} item{files.length === 1 ? "" : "s"}
                </span>
                <button
                  type="button"
                  onClick={() => setShowFiles(false)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    borderRadius: 5,
                    border: "none",
                    background: "none",
                    padding: "4px 8px",
                    fontFamily: "var(--s-mono)",
                    fontSize: 11,
                    color: "var(--s-ink-soft)",
                    cursor: "pointer",
                  }}
                >
                  Back
                </button>
              </div>

              {files.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    gap: 2,
                    overflowX: "auto",
                    borderBottom: "1px solid var(--s-border-soft)",
                    padding: "8px 12px 0",
                  }}
                >
                  {files.map((file) => (
                    <button
                      type="button"
                      key={file.path}
                      onClick={() => setActivePath(file.path)}
                      style={{
                        flexShrink: 0,
                        borderRadius: "5px 5px 0 0",
                        border: "none",
                        borderBottom: activeFile?.path === file.path ? "2px solid var(--s-ink)" : "2px solid transparent",
                        background: activeFile?.path === file.path ? "var(--s-surface)" : "none",
                        padding: "6px 10px",
                        fontFamily: "var(--s-mono)",
                        fontSize: 11,
                        color: activeFile?.path === file.path ? "var(--s-ink)" : "var(--s-ink-mute)",
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        marginBottom: -1,
                      }}
                    >
                      {file.path}
                      <span style={{ marginLeft: 4, color: "var(--s-ink-mute)", fontSize: 10 }}>{formatBytes(file.size)}</span>
                    </button>
                  ))}
                </div>
              )}

              <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }}>
                <pre
                  style={{
                    flex: 1,
                    minHeight: 0,
                    overflowY: "auto",
                    margin: 0,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    background: "var(--s-surface)",
                    padding: "16px",
                    fontFamily: "var(--s-mono)",
                    fontSize: 11.5,
                    lineHeight: 1.65,
                    color: "var(--s-ink-soft)",
                  }}
                >
                  {activeFile?.content_text || "Preview is unavailable for this file."}
                </pre>
              </div>

              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 12,
                  borderTop: "1px solid var(--s-border-soft)",
                  padding: "12px 16px",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <SenderAvatar name={senderName} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--s-ink)" }}>Workeros</div>
                    <div style={{ fontFamily: "var(--s-mono)", fontSize: 10.5, color: "var(--s-ink-mute)" }}>Shared content</div>
                  </div>
                </div>
                <div
                  style={{
                    borderRadius: 7,
                    border: "1px solid #c5dfc9",
                    background: "#edf7ef",
                    padding: "8px 12px",
                    fontSize: 11,
                    lineHeight: 1.5,
                    color: "var(--s-ink-soft)",
                  }}
                >
                  <strong style={{ fontWeight: 600, color: "var(--s-ink)" }}>Public preview.</strong>{" "}
                  Review the visible content before downloading or copying.
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Bottom conversion CTA — matches reference: neutral band, black button with arrow */}
        <div
          style={{
            marginTop: 16,
            width: "100%",
            borderRadius: 11,
            border: "1px solid #e2e2e0",
            background: "#f0f0ee",
            padding: "16px 20px",
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
          }}
        >
          <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "#555552" }}>
            Like this? Start your own team&#39;s skill library on Workeros.
          </p>
          <a
            href="/login"
            style={{
              display: "inline-flex",
              height: 34,
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 7,
              border: "none",
              background: "#141414",
              padding: "0 14px",
              fontSize: 13,
              fontWeight: 500,
              color: "#ffffff",
              textDecoration: "none",
              letterSpacing: "-0.01em",
              whiteSpace: "nowrap",
            }}
          >
            Start your workspace →
          </a>
        </div>
      </div>
    </main>
  );
}
