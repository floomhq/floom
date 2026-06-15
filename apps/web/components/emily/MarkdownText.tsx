"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { sanitizeHref } from "@/lib/safe-url";
import { useTextStream } from "@/lib/useTextStream";

/**
 * MarkdownText -- renders assistant message text as real markdown.
 * No raw **bold**. Uses remark-gfm for tables, lists, strikethrough.
 * Styling is tight/minimal to match the low-density design bar.
 */
export function MarkdownText({
  text,
  className,
  streaming = false,
}: {
  text: string;
  className?: string;
  /** When true, animates token reveal with a typewriter effect. */
  streaming?: boolean;
}) {
  const displayed = useTextStream(text, streaming, "typewriter");
  return (
    <div className={cn("text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        // Use `displayed` (animated) instead of `text` so streaming feels smooth
        key={streaming ? undefined : text}
        components={{
          p: ({ children }) => (
            <p className="mb-1.5 last:mb-0">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="mt-1 mb-1.5 ml-4 list-disc space-y-0.5 last:mb-0">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="mt-1 mb-1.5 ml-4 list-decimal space-y-0.5 last:mb-0">{children}</ol>
          ),
          li: ({ children }) => <li className="text-sm">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          em: ({ children }) => <em className="italic">{children}</em>,
          code: ({ children, className: codeClass }) => {
            // Inline code (no language class) vs fenced block
            const isBlock = codeClass?.startsWith("language-");
            if (isBlock) {
              return (
                <code className={cn("block rounded-md bg-muted px-3 py-2 text-[11px] font-mono leading-relaxed overflow-x-auto my-1.5", codeClass)}>
                  {children}
                </code>
              );
            }
            return (
              <code className="rounded bg-muted px-1 py-0.5 text-[11px] font-mono">{children}</code>
            );
          },
          pre: ({ children }) => <>{children}</>,
          a: ({ href, children }) => {
            const safe = sanitizeHref(href);
            // #825/#903 — Emily references app pages (workers/runs/folders) as
            // REAL router links: client-side navigation, no new tab. External
            // links keep target=_blank.
            const isInternal =
              !!safe && (safe.startsWith("/") || safe.startsWith("#") || safe.startsWith("?"));
            const className =
              "underline underline-offset-2 text-foreground hover:text-muted-foreground transition-colors break-all";
            if (isInternal) {
              return (
                <Link href={safe} className={className}>
                  {children}
                </Link>
              );
            }
            return (
              <a href={safe} target="_blank" rel="noopener noreferrer" className={className}>
                {children}
              </a>
            );
          },
          blockquote: ({ children }) => (
            <blockquote className="[border-left:var(--bd-div)] pl-3 text-muted-foreground my-1.5">
              {children}
            </blockquote>
          ),
          // GFM table overrides: without these, remark-gfm emits bare <table>/<td>
          // with no padding, causing columns to collide ("Slack Weekly RecapScheduleEnabled").
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-[var(--radius-button)] [border:var(--bd-card)]">
              <table className="w-full border-collapse text-sm">{children}</table>
            </div>
          ),
          thead: ({ children }) => <thead>{children}</thead>,
          tbody: ({ children }) => <tbody>{children}</tbody>,
          tr: ({ children }) => <tr className="[&:not(:last-child)]:[border-bottom:var(--bd-div)]">{children}</tr>,
          th: ({ children }) => (
            <th className="bg-muted px-3 py-1.5 text-left text-xs font-medium text-muted-foreground [border-bottom:var(--bd-div)]">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-3 py-1.5 text-xs [&:not(:last-child)]:[border-right:var(--bd-div)]">
              {children}
            </td>
          ),
        }}
      >
        {displayed}
      </ReactMarkdown>
    </div>
  );
}
