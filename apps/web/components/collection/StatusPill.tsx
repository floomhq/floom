import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { StatusPillSpec } from "@/lib/collection/types";

/** Outlined/tinted status pill with a leading dot (SPEC §2a). When the caller
 *  supplies `reason` (#1208), the pill becomes a tooltip trigger explaining
 *  WHY it's in that state, instead of being a dead end. No behavior change
 *  for collections that don't set `reason`. */
export function StatusPill({ spec }: { spec: StatusPillSpec }) {
  const dotAndLabel = (
    <>
      <span className="dot" />
      {spec.label}
    </>
  );

  if (!spec.reason) {
    return <span className={`c-pill ${spec.tone}`}>{dotAndLabel}</span>;
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger render={<span className={`c-pill ${spec.tone}`} tabIndex={0} />}>
          {dotAndLabel}
        </TooltipTrigger>
        <TooltipContent>{spec.reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
