const RUNTIME_LABELS: Record<string, string> = {
  skill: "Agent skill",
  python311: "Python 3.11",
  node22: "Node.js 22",
  bash: "Bash",
  none: "Agent loop",
};

const RUNNER_LABELS: Record<string, string> = {
  e2b: "E2B sandbox",
  local: "E2B sandbox",
};

function titleCaseToken(value: string): string {
  return value
    .split(/[-_./]+/)
    .filter(Boolean)
    .map((part) => {
      if (/^e2b$/i.test(part)) return "E2B";
      if (/^node$/i.test(part)) return "Node.js";
      if (/^python$/i.test(part)) return "Python";
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(" ");
}

export function runtimeKindLabel(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) return "Runtime not set";
  return RUNTIME_LABELS[raw] ?? titleCaseToken(raw);
}

export function runnerLabel(value: string | null | undefined): string {
  const raw = value?.trim();
  if (!raw) return "Runner not set";
  return RUNNER_LABELS[raw] ?? titleCaseToken(raw);
}

export function runtimeSummary({
  runner,
  runtime,
}: {
  runner?: string | null;
  runtime?: string | null;
}): string {
  const parts = [runnerLabel(runner), runtimeKindLabel(runtime)].filter(
    (part) => !/not set$/i.test(part),
  );
  return parts.length ? parts.join(" · ") : "Runtime not set";
}
