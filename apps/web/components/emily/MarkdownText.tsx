import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

/**
 * MarkdownText -- renders assistant message text as real markdown.
 * No raw **bold**. Uses remark-gfm for tables, lists, strikethrough.
 * Styling is tight/minimal to match the low-density design bar.
 */
export function MarkdownText({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn("text-sm leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
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
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="underline underline-offset-2 text-foreground hover:text-muted-foreground transition-colors break-all"
            >
              {children}
            </a>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border/60 pl-3 text-muted-foreground my-1.5">
              {children}
            </blockquote>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
