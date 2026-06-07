/**
 * PromptText — inline tool-name highlight for prompt strings.
 *
 * Scans text for known tool names and renders matched terms with a faint
 * rounded background + small brand icon. Non-matched text is plain. No coloured
 * badges, no gradients — just enough chrome to signal "we know this tool".
 *
 * The detection logic lives in the ONE shared detector (`lib/prompt-detect`) so
 * this inline highlight, the PromptChips row, and the backend connection-wiring
 * never disagree about what a prompt touches. This component is the inline
 * variant; PromptChips is the chips-under-the-box variant.
 */

import { BrandLogo } from "@/components/connections/BrandLogo";
import { tokenisePrompt } from "@/lib/prompt-detect";

export function PromptText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const segments = tokenisePrompt(children);

  return (
    <span className={className}>
      {segments.map((seg, i) => {
        if (seg.kind === "plain") {
          return <span key={i}>{seg.text}</span>;
        }
        return (
          <span
            key={i}
            className="inline-flex items-baseline gap-[3px] rounded-[4px] bg-muted/50 px-[5px] py-[1px] mx-[1px] align-baseline whitespace-nowrap"
          >
            {seg.brand && (
              <BrandLogo
                icon={seg.brand}
                className="size-[13px] shrink-0 translate-y-[1px]"
              />
            )}
            <span>{seg.text}</span>
          </span>
        );
      })}
    </span>
  );
}
