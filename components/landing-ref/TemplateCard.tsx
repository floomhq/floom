import Link from "next/link";
import type { ComponentType } from "react";
import {
  ArrowUp,
  BarChart3,
  DollarSign,
  Headphones,
  type LucideProps,
  Search as SearchIcon,
  Sparkles,
  TrendingUp,
  UserPlus,
  Workflow,
} from "lucide-react";
import { ToolLogoChip } from "./logos";
import type { Category, Template } from "./data";

const ACCENT = "#3a6ea5";

const ROLE_ICONS: Record<Category, ComponentType<LucideProps>> = {
  Sales: TrendingUp,
  Ops: Workflow,
  Founder: Sparkles,
  Recruiting: UserPlus,
  Finance: DollarSign,
  Research: SearchIcon,
  Customer: Headphones,
};

function RoleIconTile({ category }: { category: Category }) {
  const Icon = ROLE_ICONS[category] ?? Workflow;
  return (
    <span
      aria-hidden
      className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-[10px]"
      style={{
        background: `linear-gradient(140deg, ${ACCENT} 0%, #29547e 100%)`,
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.18), 0 1px 0 rgba(0,0,0,0.08)",
      }}
    >
      <Icon className="h-[18px] w-[18px] text-white" strokeWidth={2} />
    </span>
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
      className={`group relative flex flex-col gap-3 rounded-[18px] border border-border bg-card p-5 shadow-sm transition-all duration-200 hover:-translate-y-px hover:border-[#3a6ea5]/40 hover:shadow-[0_18px_36px_-18px_rgba(58,110,165,0.30),0_4px_10px_-4px_rgba(20,20,20,0.06)] ${
        featured ? "lg:gap-4 lg:p-6" : ""
      }`}
    >
      {/* Top: role icon + name/category */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <RoleIconTile category={t.category} />
          <div className="min-w-0">
            <div className={`truncate font-semibold leading-tight text-foreground ${featured ? "text-[19px]" : "text-[15px]"}`}>
              {t.name}
            </div>
            <div className="mt-0.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              {t.category}
            </div>
          </div>
        </div>
        {t.approval === "Required" && (
          <span
            className="inline-flex h-5 shrink-0 items-center rounded-full px-1.5 text-[9.5px] font-semibold uppercase tracking-wider"
            style={{
              background: "color-mix(in srgb, #E0B349 16%, transparent)",
              color: "var(--ink)",
            }}
            title="Asks for approval before sending"
          >
            Asks first
          </span>
        )}
      </div>

      {/* Job description */}
      <p className={`text-muted-foreground ${featured ? "text-[14px] leading-relaxed" : "text-[13px] leading-snug"}`}>
        {t.job}
      </p>

      {/* Output line */}
      <div className="rounded-[10px] border border-border bg-secondary/40 px-3 py-2 text-[12px] text-foreground/85">
        <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Returns&nbsp;
        </span>
        {t.output}
      </div>

      {/* Tools */}
      <div className="flex flex-wrap gap-1.5">
        {t.tools.slice(0, featured ? 5 : 4).map((tool) => (
          <ToolLogoChip key={tool} tool={tool} size="sm" surface="app" />
        ))}
      </div>

      {/* Footer with hover CTA */}
      <div className="mt-auto flex items-center justify-between border-t border-border pt-3">
        <span className="text-[11.5px] text-muted-foreground">{t.runs}</span>
        <span
          className="inline-flex items-center gap-1 text-[12.5px] font-semibold transition-all"
          style={{ color: ACCENT }}
        >
          Hire this worker
          <ArrowUp className="h-3.5 w-3.5 rotate-90 transition-transform group-hover:translate-x-0.5" />
        </span>
      </div>
    </Link>
  );
}
