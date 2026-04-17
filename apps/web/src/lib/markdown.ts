// Tiny, dependency-free Markdown renderer used by ProtocolPage and DocsPage.
// Handles: headings (h1-h3), code blocks (with copy), inline code, bold, links,
// paragraphs, ordered/unordered lists, horizontal rules, and GitHub-flavored
// pipe tables.
//
// We intentionally do NOT pull in `marked` or `react-markdown` — the protocol
// spec is small, the docs are small, and keeping the bundle lean matters more
// than edge-case compat.

export interface TocItem {
  id: string;
  text: string;
  level: number;
}

export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .trim();
}

export function extractToc(md: string): TocItem[] {
  const toc: TocItem[] = [];
  let inFence = false;
  for (const raw of md.split('\n')) {
    if (raw.startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = raw.match(/^(#{1,3})\s+(.+)/);
    if (m) {
      const level = m[1].length;
      const text = m[2].replace(/`/g, '').trim();
      toc.push({ id: slugify(text), text, level });
    }
  }
  return toc;
}

export type Block =
  | { type: 'heading'; level: number; id: string; text: string }
  | { type: 'code'; lang: string; code: string }
  | { type: 'paragraph'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] }
  | { type: 'hr' }
  | { type: 'table'; headers: string[]; rows: string[][] };

export function parseMd(md: string): Block[] {
  const lines = md.split('\n');
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Heading
    const hm = line.match(/^(#{1,3})\s+(.+)/);
    if (hm) {
      const text = hm[2];
      blocks.push({
        type: 'heading',
        level: hm[1].length,
        id: slugify(text.replace(/`/g, '')),
        text,
      });
      i++;
      continue;
    }

    // Code fence
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    // HR
    if (/^---+$/.test(line.trim())) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    // Table (pipe syntax)
    // Detect: a line starting with `|`, followed by a separator like `| --- |`.
    if (/^\|.+\|\s*$/.test(line) && i + 1 < lines.length && /^\|\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/.test(lines[i + 1])) {
      const parseRow = (row: string) =>
        row
          .trim()
          .replace(/^\||\|$/g, '')
          .split('|')
          .map((c) => c.trim());
      const headers = parseRow(line);
      i += 2; // skip header + separator
      const rows: string[][] = [];
      while (i < lines.length && /^\|.+\|\s*$/.test(lines[i])) {
        rows.push(parseRow(lines[i]));
        i++;
      }
      blocks.push({ type: 'table', headers, rows });
      continue;
    }

    // Unordered list
    if (/^[-*] /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*] /.test(lines[i])) {
        items.push(lines[i].replace(/^[-*] /, ''));
        i++;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }

    // Ordered list
    if (/^\d+\. /.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\. /.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\. /, ''));
        i++;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }

    // Paragraph
    if (line.trim()) {
      const paraLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].startsWith('#') &&
        !lines[i].startsWith('```') &&
        !/^[-*] /.test(lines[i]) &&
        !/^\d+\. /.test(lines[i]) &&
        !/^---/.test(lines[i]) &&
        !/^\|.+\|\s*$/.test(lines[i])
      ) {
        paraLines.push(lines[i]);
        i++;
      }
      blocks.push({ type: 'paragraph', text: paraLines.join(' ') });
      continue;
    }

    i++;
  }

  return blocks;
}

export function inlineHtml(text: string): string {
  // Bold
  let s = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Inline code
  s = s.replace(
    /`([^`]+)`/g,
    '<code style="font-family:JetBrains Mono,monospace;font-size:0.88em;background:var(--bg);border:1px solid var(--line);padding:2px 6px;border-radius:4px">$1</code>',
  );
  // Links — treat internal (/docs/...) vs external differently
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    const isExternal = /^https?:\/\//.test(url);
    const target = isExternal ? ' target="_blank" rel="noreferrer"' : '';
    return `<a href="${url}"${target} style="color:var(--accent);text-decoration:underline">${label}</a>`;
  });
  return s;
}
