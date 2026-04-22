/**
 * WhyFloom — BEFORE / AFTER split.
 *
 * Replaces the old 3-card grid (2026-04-22 goosebumps pass). The card
 * grid was indistinguishable from every generic SaaS landing. This
 * section now shows the raw pain on the left (JSON the coworker can't
 * use) and the Floom outcome on the right (clean product page they
 * click once), connected with a quiet arrow.
 *
 * Left panel: hand-rolled "terminal" block with realistic JSON + curl.
 * Right panel: real screenshot of a Floom product page (lead-scorer).
 *
 * Asset: apps/web/public/landing-shots/after-product-page.png
 */
import { ArrowRight } from 'lucide-react';
import { SectionEyebrow } from './SectionEyebrow';

export function WhyFloom() {
  return (
    <section
      data-testid="home-before-after"
      data-section="before-after"
      style={{
        background: 'var(--bg)',
        padding: '88px 24px',
      }}
    >
      <div style={{ maxWidth: 1200, margin: '0 auto' }}>
        <header style={{ textAlign: 'center', marginBottom: 44 }}>
          <SectionEyebrow testid="before-after-eyebrow">
            The shape of the problem
          </SectionEyebrow>
          <h2
            style={{
              fontFamily: "'DM Serif Display', Georgia, serif",
              fontWeight: 400,
              fontSize: 44,
              lineHeight: 1.05,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
              margin: '0 0 10px',
              textWrap: 'balance' as unknown as 'balance',
            }}
          >
            Your coworkers won&apos;t run curl.
          </h2>
          <p
            style={{
              fontSize: 15.5,
              color: 'var(--muted)',
              lineHeight: 1.55,
              margin: 0,
              maxWidth: 540,
              marginLeft: 'auto',
              marginRight: 'auto',
            }}
          >
            Vibe-coded API on the left. A tool they&apos;ll actually use on the right.
          </p>
        </header>

        <div
          className="before-after-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 36px 1fr',
            gap: 0,
            alignItems: 'stretch',
          }}
        >
          {/* BEFORE — raw terminal / JSON */}
          <div
            data-testid="before-panel"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <span
              style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--muted)',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}
            >
              Before · what they&apos;d get today
            </span>
            <div
              style={{
                background: '#0f172a',
                color: '#e2e8f0',
                borderRadius: 14,
                padding: '22px 22px 24px',
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 12.5,
                lineHeight: 1.65,
                border: '1px solid #1e293b',
                flex: 1,
                minHeight: 320,
                overflow: 'hidden',
                boxShadow: '0 1px 0 rgba(0,0,0,0.04), 0 10px 24px rgba(15,23,42,0.18)',
              }}
            >
              <div style={{ color: '#64748b', marginBottom: 10 }}>
                $ curl -X POST https://api.your-app.fly.dev/score \
              </div>
              <div style={{ color: '#64748b', marginBottom: 10, paddingLeft: 18 }}>
                -H &quot;Authorization: Bearer $KEY&quot; \
              </div>
              <div style={{ color: '#64748b', marginBottom: 14, paddingLeft: 18 }}>
                -d &apos;&#123;&quot;leads&quot;:&quot;...&quot;&#125;&apos;
              </div>
              <div style={{ color: '#94a3b8' }}>&#123;</div>
              <div style={{ color: '#94a3b8', paddingLeft: 14 }}>
                &quot;status&quot;: <span style={{ color: '#34d399' }}>&quot;ok&quot;</span>,
              </div>
              <div style={{ color: '#94a3b8', paddingLeft: 14 }}>
                &quot;rows&quot;: <span style={{ color: '#fbbf24' }}>142</span>,
              </div>
              <div style={{ color: '#94a3b8', paddingLeft: 14 }}>
                &quot;data&quot;: [
              </div>
              <div style={{ color: '#94a3b8', paddingLeft: 28 }}>
                &#123;&quot;company&quot;:&quot;Acme&quot;,&quot;score&quot;:87,&quot;tier&quot;:&quot;A&quot;&#125;,
              </div>
              <div style={{ color: '#94a3b8', paddingLeft: 28 }}>
                &#123;&quot;company&quot;:&quot;Globex&quot;,&quot;score&quot;:54,&quot;tier&quot;:&quot;C&quot;&#125;,
              </div>
              <div style={{ color: '#64748b', paddingLeft: 28 }}>... 140 more</div>
              <div style={{ color: '#94a3b8', paddingLeft: 14 }}>]</div>
              <div style={{ color: '#94a3b8' }}>&#125;</div>
            </div>
            <p
              data-testid="before-caption"
              style={{
                fontSize: 13.5,
                color: 'var(--muted)',
                lineHeight: 1.5,
                margin: 0,
              }}
            >
              Your coworker can&apos;t use this.
            </p>
          </div>

          {/* Quiet arrow connector */}
          <div
            aria-hidden="true"
            className="before-after-arrow"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--accent)',
            }}
          >
            <ArrowRight size={28} strokeWidth={1.5} />
          </div>

          {/* AFTER — real Floom product page */}
          <div
            data-testid="after-panel"
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 12,
            }}
          >
            <span
              style={{
                fontFamily: "'JetBrains Mono', ui-monospace, monospace",
                fontSize: 11,
                fontWeight: 600,
                color: 'var(--accent)',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}
            >
              After · on Floom
            </span>
            <div
              style={{
                borderRadius: 14,
                overflow: 'hidden',
                border: '1px solid var(--line)',
                background: 'var(--card)',
                flex: 1,
                minHeight: 320,
                boxShadow: '0 1px 0 rgba(0,0,0,0.02), 0 10px 24px rgba(5,150,105,0.12)',
              }}
            >
              <img
                src="/landing-shots/after-product-page.png"
                alt="Lead Scorer product page on Floom"
                loading="lazy"
                decoding="async"
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  objectPosition: 'top',
                  display: 'block',
                }}
              />
            </div>
            <p
              data-testid="after-caption"
              style={{
                fontSize: 13.5,
                color: 'var(--muted)',
                lineHeight: 1.5,
                margin: 0,
              }}
            >
              They click a link. It works.
            </p>
          </div>
        </div>
      </div>

      <style>{`
        @media (max-width: 900px) {
          .before-after-grid {
            grid-template-columns: minmax(0, 1fr) !important;
            gap: 24px !important;
          }
          .before-after-arrow {
            transform: rotate(90deg);
            padding: 8px 0 !important;
          }
        }
      `}</style>
    </section>
  );
}
