// Headline-with-meta renderer for outputs where one field is clearly
// the answer and the rest are small metadata. Example: the `password`
// app returns {password, length, alphabet_size, entropy_bits} — we
// surface the password as a big monospace value and render the three
// numeric fields as muted chips. The alternative (2-col table or JSON
// dump) buries the answer under the stats.
import { CopyButton } from './CopyButton';
import { IconCopyButton } from './OutputActionBar';
import { SectionHeader } from './SectionHeader';

export interface HeadlineWithMetaProps {
  headline: string;
  headlineLabel?: string;
  meta: Array<{ label: string; value: string }>;
}

export function HeadlineWithMeta({ headline, headlineLabel, meta }: HeadlineWithMetaProps) {
  // "Token-shaped" headlines (passwords, UUIDs, generated keys with no
  // spaces) use the monospace display so the value is selectable as a
  // single chunk. Prose headlines (next-action, tldr, pricing insight)
  // use the body sans-serif at a comfortable reading size — much more
  // readable than mono at 20px.
  const isToken =
    typeof headline === 'string' && headline.length <= 64 && !/\s/.test(headline);
  const hasMeta = meta.length > 0;
  return (
    <div
      data-renderer="HeadlineWithMeta"
      className="app-expanded-card floom-output-card"
      style={{ position: 'relative' }}
    >
      {headlineLabel ? (
        <SectionHeader
          label={headlineLabel}
          actions={<IconCopyButton value={headline} label="Copy section" />}
        />
      ) : (
        <div style={{ position: 'absolute', top: 12, right: 12 }}>
          <CopyButton value={headline} label="Copy" />
        </div>
      )}
      <div
        style={{
          fontFamily: isToken
            ? "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace"
            : 'inherit',
          fontSize: isToken ? 20 : 16,
          fontWeight: isToken ? 500 : 450,
          color: 'var(--ink)',
          lineHeight: isToken ? 1.4 : 1.55,
          // Token (≤64 chars no spaces) → break-all is fine for visual
          // chunking. Prose → break on word boundaries. Long unbroken
          // strings (JWTs, base64 >64 chars) fall to the prose branch;
          // `overflowWrap: anywhere` keeps them inside the card on
          // narrow viewports instead of overflowing horizontally.
          // (codex review 2026-04-25)
          wordBreak: isToken ? 'break-all' : 'normal',
          overflowWrap: 'anywhere',
          userSelect: 'all',
          paddingRight: headlineLabel ? 0 : 72,
          marginBottom: hasMeta ? 14 : 0,
        }}
      >
        {headline}
      </div>
      {hasMeta && (
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 8,
            marginTop: 4,
          }}
        >
          {meta.map((m, i) => (
            <span
              key={i}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '4px 10px',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 999,
                fontSize: 12,
                color: 'var(--muted)',
                fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
              }}
            >
              <span style={{ color: 'var(--muted)' }}>{m.label}:</span>
              <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{m.value}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
