// #778: ride attachment text along in the chat message so Emily sees the
// content of text-like files. Pure + unit-tested.
export function buildMessageWithAttachments(
  text: string,
  files?: { name: string; text?: string | null }[]
): string {
  const extra = (files ?? [])
    .filter((f) => f.text && f.text.trim())
    .map((f) => `\n\n[Attached file: ${f.name}]\n${f.text}`)
    .join("");
  return text + extra;
}
