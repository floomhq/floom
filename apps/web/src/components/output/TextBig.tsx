// Big, legible single-value text display with an optional Copy button.
// Used for short primary outputs like a generated UUID, password, or
// short string where the value IS the answer (no decoration needed).
import { CopyButton } from './CopyButton';

export interface TextBigProps {
  value: string;
  copyable?: boolean;
}

export function TextBig({ value, copyable = true }: TextBigProps) {
  return (
    // data-renderer lets audits and DOM queries verify that the output
    // renderer cascade actually swapped in TextBig for `text` outputs.
    // Added 2026-04-18 (audit bug #9) after the previous audit couldn't
    // confirm cascade claims because components applied inline styles
    // without identity.
    <div data-renderer="TextBig" className="app-expanded-card floom-output-card" style={{ position: 'relative' }}>
      {copyable && (
        <div style={{ position: 'absolute', top: 12, right: 12 }}>
          <CopyButton value={value} label="Copy" />
        </div>
      )}
      <div
        style={{
          fontFamily: "'JetBrains Mono', monospace",
          fontSize: 18,
          fontWeight: 500,
          wordBreak: 'break-all',
          userSelect: 'all',
          paddingRight: copyable ? 72 : 0,
          lineHeight: 1.5,
        }}
      >
        {value}
      </div>
    </div>
  );
}
