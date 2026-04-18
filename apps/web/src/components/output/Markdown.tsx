// Markdown/plain-text renderer. Preserves the pre-v16 OutputPanel
// polish: whitespace-preserved wrap, relative position so a CopyButton
// can sit in the top-right corner. Intentionally does NOT parse the
// markdown into HTML — the previous OutputPanel rendered raw text with
// pre-wrap and that is what consumers expect today (see PR #7). A real
// markdown-to-HTML pass is a separate, opt-in change because it needs
// sanitization review.
import { CopyButton } from './CopyButton';

export interface MarkdownProps {
  content: string;
  copyable?: boolean;
}

export function Markdown({ content, copyable = true }: MarkdownProps) {
  return (
    // data-renderer lets audits confirm the cascade mapped markdown /
    // long-text outputs to this component. Added 2026-04-18 (bug #9).
    <div
      data-renderer="Markdown"
      className="app-expanded-card"
      style={{
        position: 'relative',
        whiteSpace: 'pre-wrap',
        fontSize: 14,
        lineHeight: 1.6,
      }}
    >
      {copyable && (
        <div style={{ position: 'absolute', top: 12, right: 12 }}>
          <CopyButton value={content} label="Copy markdown" />
        </div>
      )}
      {content}
    </div>
  );
}
