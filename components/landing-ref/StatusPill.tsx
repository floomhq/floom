export type PillTone = "default" | "success" | "warning" | "pending" | "muted";

const TONES: Record<PillTone, string> = {
  default: "bg-secondary text-foreground border-border",
  success: "bg-[oklch(0.95_0.05_150)] text-[oklch(0.42_0.13_150)] border-[oklch(0.85_0.07_150)]",
  warning: "bg-[oklch(0.95_0.08_30)] text-[oklch(0.50_0.18_30)] border-[oklch(0.85_0.10_30)]",
  pending: "bg-[oklch(0.96_0.07_80)] text-[oklch(0.45_0.13_80)] border-[oklch(0.88_0.09_80)]",
  muted: "bg-muted text-muted-foreground border-border",
};

// Known labelled statuses → tone. Keeps status language consistent everywhere.
const LABEL_TONE: Record<string, PillTone> = {
  "output ready": "success",
  completed: "success",
  connected: "success",
  live: "success",
  running: "pending",
  draft: "pending",
  "approval required": "warning",
  required: "warning",
  optional: "muted",
  "auto-run": "default",
};

export function StatusPill({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: PillTone;
}) {
  const resolved =
    tone ??
    (typeof children === "string" ? LABEL_TONE[children.toLowerCase()] : undefined) ??
    "default";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wider ${TONES[resolved]}`}
    >
      {children}
    </span>
  );
}
