import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ToolLogoChip } from "./logos";
import { StatusPill } from "./StatusPill";
import type { Template } from "./data";

function MetaRow({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex gap-2 text-[12.5px]">
      <span className="w-20 shrink-0 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {k}
      </span>
      <span className="text-foreground/85">{v}</span>
    </div>
  );
}

export function TemplateCard({
  t,
  featured = false,
}: {
  t: Template;
  featured?: boolean;
}) {
  return (
    <Link
      href={`/templates/${t.slug}`}
      className={`group flex flex-col gap-3 rounded-[18px] border border-border bg-card p-5 shadow-sm transition hover:-translate-y-px hover:shadow-md ${
        featured ? "lg:gap-4 lg:p-6" : ""
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
          {t.category}
        </span>
        <StatusPill tone={t.approval === "Required" ? "warning" : t.approval === "Optional" ? "muted" : "default"}>
          Approval {t.approval.toLowerCase()}
        </StatusPill>
      </div>
      <div>
        <div className={`font-semibold text-foreground ${featured ? "text-[19px]" : "text-[15px]"}`}>
          {t.name}
        </div>
        <p className={`mt-1 text-muted-foreground ${featured ? "text-[14px]" : "text-[13px]"}`}>
          {t.job}
        </p>
      </div>
      <div className="space-y-1.5">
        <MetaRow k="Output" v={t.output} />
        <MetaRow k="Runs when" v={t.runs} />
        {featured && <MetaRow k="Approval" v={t.approvalNote} />}
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1">
        {t.tools.slice(0, featured ? 5 : 4).map((tool) => (
          <ToolLogoChip key={tool} tool={tool} size="sm" surface="app" />
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-border pt-3 text-[12.5px] font-medium text-foreground">
        View template
        <ArrowRight className="h-3.5 w-3.5 transition group-hover:translate-x-0.5" />
      </div>
    </Link>
  );
}
