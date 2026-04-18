// Lightweight code block with Copy and Download buttons.
// Deliberately avoids pulling in a syntax-highlighting library (Prism /
// highlight.js add ~50-100KB). We lean on the monospace font + good
// contrast and leave highlighting as a follow-up if a need appears.
// `language` controls the download filename extension and the aria label
// but not colours.
import { CopyButton } from './CopyButton';

export interface CodeBlockProps {
  code: string;
  language?: string;
  filename?: string;
}

const LANGUAGE_EXT: Record<string, string> = {
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  xml: 'xml',
  html: 'html',
  css: 'css',
  javascript: 'js',
  js: 'js',
  typescript: 'ts',
  ts: 'ts',
  python: 'py',
  py: 'py',
  bash: 'sh',
  shell: 'sh',
  sh: 'sh',
  sql: 'sql',
  markdown: 'md',
  md: 'md',
};

export function CodeBlock({ code, language, filename }: CodeBlockProps) {
  const ext = language ? LANGUAGE_EXT[language.toLowerCase()] || 'txt' : 'txt';
  const downloadName = filename || `output.${ext}`;

  const download = () => {
    const blob = new Blob([code], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = downloadName;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    // data-renderer lets audits confirm the cascade mapped `code` /
    // `json-format` outputs to CodeBlock. Added 2026-04-18 (bug #9).
    <div data-renderer="CodeBlock" className="app-expanded-card" style={{ position: 'relative' }}>
      <div
        style={{
          position: 'sticky',
          top: 0,
          display: 'flex',
          justifyContent: 'flex-end',
          gap: 6,
          marginBottom: 4,
          zIndex: 1,
        }}
      >
        <button type="button" className="output-copy-btn" onClick={download}>
          Download
        </button>
        <CopyButton value={code} label="Copy" />
      </div>
      <pre
        aria-label={language ? `${language} code` : 'code'}
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          margin: 0,
          maxHeight: 480,
          overflow: 'auto',
        }}
      >
        {code}
      </pre>
    </div>
  );
}
