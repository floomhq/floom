"use client";

import { useEffect, useState } from "react";
import "highlight.js/styles/github.css";

// ---------------------------------------------------------------------------
// Canonical syntax-highlighted code block, shared by the Brain file viewer and
// the worker-detail Source view so a .py/.ts/.json/.yaml/.txt file renders
// identically across surfaces.
//
// The global `.hljs { background: transparent !important; }` rule in
// globals.css neutralises the github.css theme background, so the rounded
// dark/light-aware `bg-[var(--bg-2)]` surface below shows through in both
// themes (dark uses #1a1a1a; the `.dark .hljs-*` token colors in globals.css
// supply the dark palette).
// ---------------------------------------------------------------------------

export function detectLanguage(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".sh") || p.endsWith(".bash")) return "bash";
  if (p.endsWith(".ts") || p.endsWith(".tsx")) return "typescript";
  if (p.endsWith(".js") || p.endsWith(".jsx") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "javascript";
  if (p.endsWith(".sql")) return "sql";
  if (p.endsWith(".xml") || p.endsWith(".html") || p.endsWith(".htm")) return "xml";
  if (p.endsWith(".css") || p.endsWith(".scss")) return "css";
  if (p.endsWith(".go")) return "go";
  if (p.endsWith(".rs")) return "rust";
  return "text";
}

const LANGUAGE_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  python: () => import("highlight.js/lib/languages/python"),
  yaml: () => import("highlight.js/lib/languages/yaml"),
  json: () => import("highlight.js/lib/languages/json"),
  bash: () => import("highlight.js/lib/languages/bash"),
  typescript: () => import("highlight.js/lib/languages/typescript"),
  javascript: () => import("highlight.js/lib/languages/javascript"),
  sql: () => import("highlight.js/lib/languages/sql"),
  xml: () => import("highlight.js/lib/languages/xml"),
  css: () => import("highlight.js/lib/languages/css"),
  go: () => import("highlight.js/lib/languages/go"),
  rust: () => import("highlight.js/lib/languages/rust"),
};

/**
 * The canonical rounded, syntax-highlighted code block. One view per code/
 * structured file — no redundant Preview-vs-Rendered split. Pass `language` to
 * override the path-based detection (e.g. when a backend supplies it).
 */
export function CodeBlock({
  text,
  filePath,
  language,
}: {
  text: string;
  filePath: string;
  language?: string;
}) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const lang = language && language !== "plaintext" ? language : detectLanguage(filePath);

  useEffect(() => {
    let cancelled = false;
    if (lang === "text") {
      setHighlighted(null);
      return;
    }

    import("highlight.js/lib/core")
      .then(async (hljsCore) => {
        const hljs = hljsCore.default;
        const loader = LANGUAGE_LOADERS[lang];
        if (loader && !hljs.getLanguage(lang)) {
          const mod = await loader();
          hljs.registerLanguage(lang, mod.default as Parameters<typeof hljs.registerLanguage>[1]);
        }
        if (!cancelled && hljs.getLanguage(lang)) {
          const result = hljs.highlight(text, { language: lang });
          if (!cancelled) setHighlighted(result.value);
        } else if (!cancelled) {
          setHighlighted(null);
        }
      })
      .catch(() => {
        /* fall back to plain text */
      });

    return () => {
      cancelled = true;
    };
  }, [text, lang]);

  return (
    <div className="p-0">
      <pre className="max-w-full overflow-auto rounded-[var(--radius-button)] bg-[var(--bg-2)] p-3 font-mono text-xs leading-6 text-foreground dark:bg-[#1a1a1a]">
        {highlighted ? (
          <code
            className={`hljs language-${lang}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code className="hljs">{text}</code>
        )}
      </pre>
    </div>
  );
}
