import type { OutputSpec } from '../../lib/types';

export interface OutputPlaceholderStubProps {
  outputs: OutputSpec[];
}

export function OutputPlaceholderStub({ outputs }: OutputPlaceholderStubProps) {
  if (!outputs || outputs.length === 0) return null;

  return (
    <div style={{ margin: '24px 20px 0' }}>
      <div style={{
        fontSize: 11,
        fontWeight: 700,
        color: 'var(--muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        marginBottom: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 8
      }}>
        <div style={{ width: 12, height: 1.5, background: 'var(--line)' }} />
        Result surface preview
      </div>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))',
        gap: 12
      }}>
        {outputs.map((out) => (
          <div
            key={out.name}
            style={{
              padding: '14px',
              background: 'var(--bg)',
              border: '1px solid var(--line)',
              borderRadius: 10,
              opacity: 0.7,
              display: 'flex',
              flexDirection: 'column',
              gap: 4
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
              {out.label || out.name}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{
                fontSize: 10,
                fontWeight: 700,
                padding: '2px 6px',
                background: 'var(--line)',
                borderRadius: 4,
                color: 'var(--muted)',
                textTransform: 'uppercase'
              }}>
                {out.type}
              </span>
              {out.description && (
                <span style={{ 
                  fontSize: 11, 
                  color: 'var(--muted)', 
                  whiteSpace: 'nowrap', 
                  overflow: 'hidden', 
                  textOverflow: 'ellipsis' 
                }}>
                  {out.description}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      <div style={{ marginTop: 12, fontSize: 12, color: 'var(--muted)', fontStyle: 'italic' }}>
        Actual output will be rendered using the {outputs.length > 1 ? 'best components' : 'best component'} for these data types.
      </div>
    </div>
  );
}
