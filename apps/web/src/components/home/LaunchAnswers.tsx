import { Link } from 'react-router-dom';
import { SectionEyebrow } from './SectionEyebrow';

const ANSWERS = [
  {
    title: 'Runtime caps',
    body: 'Fresh container per hosted run. Sync runs cap at 5 minutes. Default budget: 512 MB and 1 vCPU.',
    to: '/docs/limits',
    cta: 'See runtime limits',
  },
  {
    title: 'Secrets and BYOK',
    body: 'Saved secrets are encrypted at rest. Bring-your-own keys stay in your browser unless you choose to save one.',
    to: '/docs/security',
    cta: 'See security details',
  },
  {
    title: 'Ownership',
    body: 'MIT runtime. Self-hostable. Your code, manifest, and OpenAPI contract stay portable.',
    to: '/docs/ownership',
    cta: 'See ownership',
  },
  {
    title: 'Reliability',
    body: 'Preview-first deploys. Manual prod promotion. No formal SLA is published for launch week.',
    to: '/docs/reliability',
    cta: 'See reliability',
  },
] as const;

export function LaunchAnswers() {
  return (
    <section
      data-testid="home-launch-answers"
      data-section="launch-answers"
      style={{
        background: 'var(--bg)',
        padding: '56px 24px 72px',
        borderBottom: '1px solid var(--line)',
      }}
    >
      <div style={{ maxWidth: 1040, margin: '0 auto' }}>
        <header style={{ textAlign: 'center', marginBottom: 28 }}>
          <SectionEyebrow testid="launch-answers-eyebrow">
            Launch-week answers
          </SectionEyebrow>
          <h2
            style={{
              fontFamily: 'var(--font-display)',
              fontWeight: 700,
              fontSize: 36,
              lineHeight: 1.1,
              letterSpacing: '-0.02em',
              color: 'var(--ink)',
              margin: '0 0 12px',
            }}
          >
            Know the limits before you build.
          </h2>
          <p
            style={{
              maxWidth: 700,
              margin: '0 auto',
              fontSize: 15,
              lineHeight: 1.6,
              color: 'var(--muted)',
            }}
          >
            The runtime, security, ownership, and launch-week reliability answers
            are public and code-backed.
          </p>
        </header>

        <div
          className="launch-answers-grid"
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
            gap: 14,
          }}
        >
          {ANSWERS.map((answer) => (
            <article
              key={answer.title}
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 14,
                padding: 20,
                display: 'flex',
                flexDirection: 'column',
                gap: 12,
              }}
            >
              <h3
                style={{
                  fontSize: 18,
                  lineHeight: 1.25,
                  letterSpacing: '-0.01em',
                  color: 'var(--ink)',
                  margin: 0,
                }}
              >
                {answer.title}
              </h3>
              <p
                style={{
                  margin: 0,
                  fontSize: 14,
                  lineHeight: 1.6,
                  color: 'var(--muted)',
                }}
              >
                {answer.body}
              </p>
              <Link
                to={answer.to}
                style={{
                  marginTop: 'auto',
                  fontSize: 13,
                  fontWeight: 600,
                  color: 'var(--accent)',
                  textDecoration: 'none',
                }}
              >
                {answer.cta} →
              </Link>
            </article>
          ))}
        </div>

        <p
          style={{
            margin: '18px auto 0',
            maxWidth: 760,
            fontSize: 13,
            lineHeight: 1.6,
            color: 'var(--muted)',
            textAlign: 'center',
          }}
        >
          Run and log retention is operator-controlled today. This repo does not
          implement an automatic deletion window.
        </p>
      </div>

    </section>
  );
}
