"use client";

/**
 * Emily chat — export the current conversation.
 *
 * Markdown is the requirement (readable user/assistant turns, tool actions
 * noted briefly). JSON is a bonus for machine round-tripping.
 */

import type { ChatMessage, MsgPart } from "./emily-chat-types";

function partToMarkdown(part: MsgPart): string {
  if (part.type === "text") {
    return part.text;
  }
  // tool-card
  const card = part.card;
  const title =
    "title" in card && card.title
      ? card.title
      : "toolName" in card && card.toolName
        ? card.toolName
        : card.kind;
  const status = card.status ? ` (${card.status})` : "";
  return `> _Tool: ${title}${status}_`;
}

export function conversationToMarkdown(
  messages: ChatMessage[],
  opts?: { title?: string }
): string {
  const lines: string[] = [];
  lines.push(`# ${opts?.title || "Emily conversation"}`);
  lines.push("");
  lines.push(`_Exported ${new Date().toLocaleString()}_`);
  lines.push("");

  for (const msg of messages) {
    if (msg.role === "user") {
      lines.push("## You");
      if (msg.text) lines.push(msg.text);
      if (msg.files && msg.files.length > 0) {
        lines.push("");
        lines.push(
          `_Attachments: ${msg.files.map((f) => f.name).join(", ")}_`
        );
      }
    } else {
      lines.push("## Emily");
      const parts = msg.parts ?? [];
      const rendered = parts
        .map(partToMarkdown)
        .filter((s) => s.trim().length > 0);
      lines.push(rendered.join("\n\n"));
    }
    lines.push("");
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

export function conversationToJson(
  messages: ChatMessage[],
  conversationId: string | null
): string {
  return JSON.stringify(
    { conversationId, exportedAt: new Date().toISOString(), messages },
    null,
    2
  );
}

function triggerDownload(filename: string, content: string, mime: string): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

export function exportConversationMarkdown(
  messages: ChatMessage[],
  conversationId: string | null
): void {
  const md = conversationToMarkdown(messages, { title: "Emily conversation" });
  const idPart = conversationId ? `-${conversationId.slice(0, 8)}` : "";
  triggerDownload(
    `emily-conversation${idPart}-${timestampSlug()}.md`,
    md,
    "text/markdown;charset=utf-8"
  );
}

export function exportConversationJson(
  messages: ChatMessage[],
  conversationId: string | null
): void {
  const json = conversationToJson(messages, conversationId);
  const idPart = conversationId ? `-${conversationId.slice(0, 8)}` : "";
  triggerDownload(
    `emily-conversation${idPart}-${timestampSlug()}.json`,
    json,
    "application/json;charset=utf-8"
  );
}
