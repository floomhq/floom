import type { StatusPillSpec } from "@/lib/collection/types";

/** Outlined/tinted status pill with a leading dot (SPEC §2a). */
export function StatusPill({ spec }: { spec: StatusPillSpec }) {
  return (
    <span className={`c-pill ${spec.tone}`}>
      <span className="dot" />
      {spec.label}
    </span>
  );
}
