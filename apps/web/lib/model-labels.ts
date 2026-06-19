const KNOWN_MODEL_LABELS: Record<string, string> = {
  "bedrock/us.anthropic.claude-sonnet-4-6": "Claude Sonnet 4.6",
  "us.anthropic.claude-sonnet-4-6": "Claude Sonnet 4.6",
  "claude-sonnet-4-6": "Claude Sonnet 4.6",
  "anthropic.claude-sonnet-4-5": "Claude Sonnet 4.5",
  "claude-sonnet-4-5": "Claude Sonnet 4.5",
  "anthropic.claude-opus-4-1": "Claude Opus 4.1",
  "claude-opus-4-1": "Claude Opus 4.1",
  "claude-opus-4-8": "Claude Opus 4.8",
  "gpt-5": "GPT-5",
  "gpt-5-mini": "GPT-5 Mini",
  "gpt-5-nano": "GPT-5 Nano",
  // CW-03a: GPT-5.x dotted variants — titleCaseToken would split the dot and
  // produce "GPT 5 5" instead of "GPT-5.5"; enumerate them explicitly.
  "gpt-5.5": "GPT-5.5",
  "gpt-5.4": "GPT-5.4",
  "gpt-5.4-mini": "GPT-5.4 Mini",
  "gpt-5.1": "GPT-5.1",
  "gpt-5.1-mini": "GPT-5.1 Mini",
  "gpt-4o": "GPT-4o",
  "gpt-4o-mini": "GPT-4o Mini",
  "gpt-4-turbo": "GPT-4 Turbo",
};

function titleCaseToken(value: string): string {
  // CW-03a: split ONLY on hyphens/underscores, never on dots, so version
  // strings like "5.5" or "4.0" survive intact as a single token.
  return value
    .replace(/[-_]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return "GPT";
      if (/^claude$/i.test(part)) return "Claude";
      if (/^sonnet$/i.test(part)) return "Sonnet";
      if (/^opus$/i.test(part)) return "Opus";
      if (/^\d[\d.]*$/.test(part)) return part; // numeric / version token (e.g. "5.5", "4")
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function modelLabel(modelId: string | null | undefined): string {
  const raw = modelId?.trim();
  if (!raw) return "Not set";
  const known = KNOWN_MODEL_LABELS[raw];
  if (known) return known;
  const leaf = raw.split("/").pop() ?? raw;
  return titleCaseToken(leaf.replace(/^anthropic\./, ""));
}
