/**
 * LayersGrid — "What's in the box."
 *
 * ICP is locked (creators + biz users, NOT devs). Previous version
 * exposed implementation details (typed manifest, docker runner,
 * OpenAPI spec, TSX renderer) that only platform engineers read
 * without confusion. Rewritten 2026-04-19 into plain-English
 * benefits, one short line per card, no code snippets.
 *
 * v4 (2026-04-20): added icon-badges per card + section eyebrow.
 * Matches the v16 feature-card pattern.
 *
 * Total visible body text under 100 words (verified via DOM).
 */
import { Link2, Zap, Layout, History, Lock } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { SectionEyebrow } from './SectionEyebrow';

interface Layer {
  name: string;
  desc: string;
  Icon: LucideIcon;
}

const LAYERS: Layer[] = [
  {
    name: 'Paste a repo or spec',
    desc: 'A public GitHub repo with OpenAPI, or a direct OpenAPI link.',
    Icon: Link2,
  },
  {
    name: 'Runs on its own',
    desc: 'No laptop to keep open. No babysitting. It\u2019s up when you are.',
    Icon: Zap,
  },
  {
    name: 'Looks like a real app',
    desc: 'A clean page your teammates can use. Not raw JSON.',
    Icon: Layout,
  },
  {
    name: 'See every run',
    desc: 'Who ran what, when. Share a link to any result.',
    Icon: History,
  },
  {
    name: 'Share on your terms',
    desc: 'Public, private, or invite-only. You decide who gets in.',
    Icon: Lock,
  },
];

export function LayersGrid() {
  return (
    <section
      data-testid="home-layers"
      data-section="layers"
      style={{
        background: 'var(--card)',
        borderTop: '1px solid var(--line)',
        borderBottom: '1px solid var(--line)',
        padding: '72px 24px',
      }}
    >
      <div style={{ maxWidth: 1040, margin: '0 auto' }}>
        <header style={{ textAlign: 'center', marginBottom: 36 }}>
          <SectionEyebrow testid="layers-eyebrow">
            What you get, out of the box
          </SectionEyebrow>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: 40,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
              margin: '0 0 10px',
            }}
          >
            What&apos;s in the box.
          </h2>
          <p
            style={{
              fontSize: 15,
              color: 'var(--muted)',
              lineHeight: 1.55,
              maxWidth: 520,
              margin: '0 auto',
            }}
          >
            Everything your app needs to behave like a real tool.
          </p>
        </header>

        <div
          className="layers-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, minmax(0, 1fr))',
            gap: 14,
          }}
        >
          {LAYERS.map((layer) => (
            <article
              key={layer.name}
              data-testid={`layer-${layer.name
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .replace(/^-|-$/g, '')}`}
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--line)',
                borderRadius: 14,
                padding: 20,
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
                minWidth: 0,
              }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 10,
                  background: '#ecfdf5',
                  color: 'var(--accent)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <layer.Icon size={18} strokeWidth={1.8} aria-hidden="true" />
              </span>
              <h3
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: 'var(--ink)',
                  margin: 0,
                  letterSpacing: '-0.01em',
                  lineHeight: 1.25,
                }}
              >
                {layer.name}
              </h3>
              <p
                style={{
                  fontSize: 13.5,
                  color: 'var(--muted)',
                  lineHeight: 1.5,
                  margin: 0,
                }}
              >
                {layer.desc}
              </p>
            </article>
          ))}
        </div>
      </div>

    </section>
  );
}
