import { useState } from 'react';
import { Copy, Check } from 'lucide-react';

// Concrete plug-in snippet for any agent. Tabs cover the three obvious
// surfaces: Claude Desktop (mcp config), Cursor (mcp config), and curl.
// Real, copy-pasteable, no placeholders.

type ConfigTab = 'claude' | 'cursor' | 'curl';

const CLAUDE_CONFIG = `{
  "mcpServers": {
    "floom-flyfast": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-remote",
        "https://preview.floom.dev/mcp/app/flyfast"
      ]
    }
  }
}`;

const CURSOR_CONFIG = `// .cursor/mcp.json
{
  "mcpServers": {
    "floom-flyfast": {
      "url": "https://preview.floom.dev/mcp/app/flyfast"
    },
    "floom-blast-radius": {
      "url": "https://preview.floom.dev/mcp/app/blast-radius"
    }
  }
}`;

const CURL_CONFIG = `# Run any Floom app over plain HTTP
curl -X POST https://preview.floom.dev/api/run \\
  -H 'content-type: application/json' \\
  -d '{
    "app_slug": "flyfast",
    "inputs": {
      "prompt": "Cheap flight from Berlin to Lisbon first week of May"
    }
  }'

# {"run_id":"run_zejqvt5zdbgh","status":"pending"}`;

const TABS: { id: ConfigTab; label: string; lang: string; code: string }[] = [
  { id: 'claude', label: 'Claude Desktop', lang: 'json', code: CLAUDE_CONFIG },
  { id: 'cursor', label: 'Cursor', lang: 'json', code: CURSOR_CONFIG },
  { id: 'curl',   label: 'curl',   lang: 'bash', code: CURL_CONFIG },
];

// Naive JSON syntax highlighter. Good enough for short config blobs.
function highlightJson(src: string) {
  const tokens: { text: string; cls: string }[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    // strings
    if (ch === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') j++;
        j++;
      }
      const str = src.slice(i, j + 1);
      // detect key vs value: next non-whitespace char is ':' -> key
      let k = j + 1;
      while (k < src.length && /\s/.test(src[k])) k++;
      const isKey = src[k] === ':';
      tokens.push({ text: str, cls: isKey ? 'tk-key' : 'tk-str' });
      i = j + 1;
      continue;
    }
    // numbers
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < src.length && /[0-9.]/.test(src[j])) j++;
      tokens.push({ text: src.slice(i, j), cls: 'tk-num' });
      i = j;
      continue;
    }
    // booleans/null
    const bool = src.slice(i).match(/^(true|false|null)\b/);
    if (bool) {
      tokens.push({ text: bool[0], cls: 'tk-bool' });
      i += bool[0].length;
      continue;
    }
    // punctuation
    if ('{}[],:'.includes(ch)) {
      tokens.push({ text: ch, cls: 'tk-punc' });
      i++;
      continue;
    }
    tokens.push({ text: ch, cls: '' });
    i++;
  }
  return tokens;
}

function highlightBash(src: string) {
  // Color comments and the curl/flag bits.
  return src.split('\n').map((line, idx) => {
    if (line.trim().startsWith('#')) {
      return <div key={idx}><span className="tk-comment">{line}</span></div>;
    }
    const parts: { text: string; cls: string }[] = [];
    const tokens = line.split(/(\s+)/);
    tokens.forEach((tok) => {
      if (!tok) return;
      if (tok === 'curl') {
        parts.push({ text: tok, cls: 'tk-fn' });
      } else if (/^-/.test(tok)) {
        parts.push({ text: tok, cls: 'tk-flag' });
      } else if (/^'/.test(tok) || /^"/.test(tok)) {
        parts.push({ text: tok, cls: 'tk-str' });
      } else {
        parts.push({ text: tok, cls: '' });
      }
    });
    return (
      <div key={idx}>
        {parts.map((p, k) => (
          <span key={k} className={p.cls}>{p.text}</span>
        ))}
      </div>
    );
  });
}

export function ClaudeDesktopConfig() {
  const [tab, setTab] = useState<ConfigTab>('claude');
  const [copied, setCopied] = useState(false);

  const active = TABS.find((t) => t.id === tab)!;

  const copy = () => {
    try {
      navigator.clipboard.writeText(active.code).catch(() => {});
    } catch { /* ignore */ }
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div className="codeblock">
      <div className="codeblock-head">
        <div className="codeblock-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={`codeblock-tab ${tab === t.id ? 'is-active' : ''}`}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <button type="button" className="codeblock-copy" onClick={copy}>
          {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
        </button>
      </div>
      <pre className="codeblock-body">
        <code>
          {active.lang === 'bash'
            ? highlightBash(active.code)
            : highlightJson(active.code).map((t, i) => (
                <span key={i} className={t.cls}>{t.text}</span>
              ))}
        </code>
      </pre>
    </div>
  );
}
