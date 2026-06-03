import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ToolLogoChip } from "./logos";
import type { Template } from "./data";

/**
 * TemplateRow — compact horizontal alternative to TemplateCard, used in the
 * landing teaser beside the featured card to avoid equal card-grid monotony.
 */
export function TemplateRow({ t }: { t: Template }) {
  return (
    <Link
      href={`/templates/${t.slug}`}
      className="group flex items-center gap-4 rounded-[18px] border border-border bg-card px-4 py-3.5 shadow-sm transition hover:-translate-y-px hover:shadow-md"
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="text-[14px] font-semibold text-foreground">{t.name}</span>
          <span className="inline-flex items-center rounded-full border border-border bg-secondary/60 px-1.5 py-px text-[10px] font-medium text-muted-foreground">
            {t.category}
          </span>
        </div>
        <p className="mt-0.5 truncate text-[12.5px] text-muted-foreground">{t.job}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {t.tools.slice(0, 3).map((tool) => (
            <ToolLogoChip key={tool} tool={tool} surface="app" />
          ))}
          {t.tools.length > 3 && (
            <span className="text-[11px] text-muted-foreground">+{t.tools.length - 3}</span>
          )}
        </div>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 text-[12.5px] font-medium text-foreground">
        View
        <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
      </span>
    </Link>
  );
}
