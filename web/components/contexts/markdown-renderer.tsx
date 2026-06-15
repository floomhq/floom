import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { sanitizeHref } from "@/lib/safe-url";

// Renders untrusted context/brain markdown. Extracted from contexts/page.tsx so
// the link-sanitization behavior (#1045) can be unit-tested in isolation.
export function MarkdownRenderer({ content }: { content: string }) {
  return (
    <div className="prose prose-sm dark:prose-invert max-w-none prose-pre:bg-muted prose-pre:[border:var(--bd-card)] prose-pre:rounded-[var(--radius-button)] prose-pre:text-foreground prose-pre:[&_code]:text-foreground prose-code:bg-muted prose-code:text-foreground prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:font-mono prose-blockquote:[border-left:var(--bd-div)] prose-blockquote:not-italic prose-headings:font-semibold prose-headings:tracking-tight">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // #1045 — sanitize anchor hrefs against the shared safe-url allowlist
          // (blocks javascript:/data:/vbscript:) instead of relying on
          // react-markdown's implicit urlTransform.
          a: ({ href, children }) => {
            const safe = sanitizeHref(href);
            return (
              <a href={safe} target="_blank" rel="noopener noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
