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
};

function titleCaseToken(value: string): string {
  return value
    .split(/[-_./]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^gpt$/i.test(part)) return "GPT";
      if (/^claude$/i.test(part)) return "Claude";
      if (/^sonnet$/i.test(part)) return "Sonnet";
      if (/^opus$/i.test(part)) return "Opus";
      if (/^\d+$/.test(part)) return part;
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
