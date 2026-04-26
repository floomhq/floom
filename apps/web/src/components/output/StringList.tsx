// Bulleted / pill list renderer for outputs that are an array of short
// strings (e.g. uuid → {uuids: ['abc-123', ...]}). Uses pill styling
// when items are short and look like tokens (uuid, slug, id); falls
// back to a bullet list for longer free text. Per-item copy button
// because the whole reason you ran the app was probably to grab one
// of these strings.
import { CopyButton } from './CopyButton';
import { SectionHeader } from './SectionHeader';

export interface StringListProps {
  items: string[];
  label?: string;
  /** Max rows shown before "+ N more" folds the tail. Default 20. */
  maxItems?: number;
}

function looksLikeToken(items: string[]): boolean {
  // All items short (<= 48 chars), no embedded spaces — renders nicely
  // as chips. Longer prose goes through the bullet list path.
  if (items.length === 0) return false;
  return items.every((s) => typeof s === 'string' && s.length <= 48 && !s.includes(' '));
}

export function StringList({ items, label, maxItems = 20 }: StringListProps) {
  const visible = items.slice(0, maxItems);
  const extra = items.length - visible.length;
  const asChips = looksLikeToken(visible);
  const allText = items.join('\n');

  return (
    <div
      data-renderer="StringList"
      className="app-expanded-card floom-output-card"
      style={{ position: 'relative' }}
    >
      <SectionHeader
        label={label ?? `${items.length} items`}
        hint={label && items.length > 1 ? `${items.length} items` : undefined}
        actions={<CopyButton value={allText} label="Copy all" />}
      />

      {asChips ? (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
          }}
        >
          {visible.map((item, i) => (
            <ChipItem key={i} value={item} />
          ))}
        </div>
      ) : (
        // Custom bullet styling: 4px green dot at the start of each
        // row gives a single accent touch and aligns the prose better
        // than browser default markers. See feedback_sexy_consumer_bar.
        <ul
          style={{
            margin: 0,
            padding: 0,
            listStyle: 'none',
            fontSize: 14,
            lineHeight: 1.55,
            color: 'var(--ink)',
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          {visible.map((item, i) => (
            <li
              key={i}
              style={{
                position: 'relative',
                paddingLeft: 18,
                wordBreak: 'break-word',
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  position: 'absolute',
                  left: 4,
                  top: 9,
                  width: 4,
                  height: 4,
                  borderRadius: '50%',
                  background: 'var(--accent, #047857)',
                  opacity: 0.55,
                }}
              />
              {item}
            </li>
          ))}
        </ul>
      )}

      {extra > 0 && (
        <div
          style={{
            marginTop: 10,
            fontSize: 12,
            color: 'var(--muted)',
            fontFamily: "'JetBrains Mono', monospace",
          }}
        >
          + {extra} more
        </div>
      )}
    </div>
  );
}

function ChipItem({ value }: { value: string }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        border: '1px solid var(--line)',
        borderRadius: 999,
        background: 'var(--card)',
        fontFamily: "'JetBrains Mono', monospace",
        fontSize: 12,
        color: 'var(--ink)',
        userSelect: 'all',
        wordBreak: 'break-all',
      }}
    >
      {value}
    </span>
  );
}
