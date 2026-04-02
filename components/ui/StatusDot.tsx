import { clsx } from "clsx";

type Status = "pending" | "running" | "success" | "error" | "timeout";

const colors: Record<Status, string> = {
  pending: "bg-gray-400",
  running: "bg-blue-500",
  success: "bg-emerald-500",
  error: "bg-red-500",
  timeout: "bg-amber-500",
};

const labels: Record<Status, string> = {
  pending: "pending",
  running: "running",
  success: "success",
  error: "error",
  timeout: "timeout",
};

export function StatusDot({
  status,
  showLabel = false,
  size = "sm",
}: {
  status: Status;
  showLabel?: boolean;
  size?: "xs" | "sm";
}) {
  const dotSize = size === "xs" ? "w-1.5 h-1.5" : "w-2 h-2";

  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={clsx(
          "rounded-full inline-block relative",
          dotSize,
          colors[status],
          status === "running" && "animate-pulse"
        )}
      />
      {showLabel && (
        <span className="text-xs text-gray-600">{labels[status]}</span>
      )}
    </span>
  );
}
