// Markdown renderer. Uses react-markdown + remark-gfm so outputs with
// headings, lists, links, bold/italic, and fenced code blocks render as
// real formatting, not a pre-wrapped blob of `# Title\n\n**bold**`.
//
// Safety: react-markdown 9 does NOT render raw HTML unless the caller
// explicitly opts in to rehype-raw. We stay on the safe default so a
// creator-controlled markdown string can't smuggle <script> into the
// Floom origin. We also whitelist the allowed tag set so future changes
// can't accidentally loosen the surface area.
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { CopyButton } from './CopyButton';

export interface MarkdownProps {
  content: string;
  copyable?: boolean;
}

const ALLOWED_ELEMENTS = [
  'p',
  'a',
  'strong',
  'em',
  'del',
  'ul',
  'ol',
  'li',
  'code',
  'pre',
  'blockquote',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'br',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
];

const COMPONENTS: Components = {
  // External links open in a new tab with noopener so creator-supplied
  // URLs can't hijack the Floom window (target=_blank without rel is a
  // known tab-napping vector).
  a: ({ href, children, ...rest }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" {...rest}>
      {children}
    </a>
  ),
};

export function Markdown({ content, copyable = true }: MarkdownProps) {
  return (
    <div
      data-renderer="Markdown"
      className="app-expanded-card markdown-output floom-output-card"
      style={{
        position: 'relative',
        fontSize: 14,
        lineHeight: 1.6,
        color: 'var(--ink)',
        overflowWrap: 'anywhere',
        wordBreak: 'break-word',
      }}
    >
      {copyable && (
        <div style={{ position: 'absolute', top: 12, right: 12 }}>
          <CopyButton value={content} label="Copy markdown" />
        </div>
      )}
      <div style={{ paddingRight: copyable ? 72 : 0 }}>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          allowedElements={ALLOWED_ELEMENTS}
          unwrapDisallowed
          components={COMPONENTS}
        >
          {content}
        </ReactMarkdown>
      </div>
    </div>
  );
}
