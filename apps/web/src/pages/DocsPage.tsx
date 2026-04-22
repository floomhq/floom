import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { FeedbackButton } from '../components/FeedbackButton';
import {
  extractToc,
  markdownComponents,
} from '../components/docs/markdown';
import limitsMd from '../assets/docs/limits.md?raw';
import securityMd from '../assets/docs/security.md?raw';
import observabilityMd from '../assets/docs/observability.md?raw';
import workflowMd from '../assets/docs/workflow.md?raw';
import ownershipMd from '../assets/docs/ownership.md?raw';
import reliabilityMd from '../assets/docs/reliability.md?raw';
import pricingMd from '../assets/docs/pricing.md?raw';

const DOCS = [
  { slug: 'limits', label: 'Runtime & limits', markdown: limitsMd },
  { slug: 'security', label: 'Security', markdown: securityMd },
  { slug: 'observability', label: 'Observability', markdown: observabilityMd },
  { slug: 'workflow', label: 'Workflow', markdown: workflowMd },
  { slug: 'ownership', label: 'Ownership', markdown: ownershipMd },
  { slug: 'reliability', label: 'Reliability', markdown: reliabilityMd },
  { slug: 'pricing', label: 'Pricing', markdown: pricingMd },
] as const;

type DocEntry = (typeof DOCS)[number];

export function DocsPage() {
  const { slug } = useParams<{ slug: string }>();
  const doc = DOCS.find((entry) => entry.slug === slug) as DocEntry | undefined;
  const [tocOpen, setTocOpen] = useState(false);

  useEffect(() => {
    if (!doc) return undefined;
    document.title = `${doc.label} · Floom Docs`;
    return () => {
      document.title = 'Floom: production layer for AI apps';
    };
  }, [doc]);

  const toc = useMemo(() => (doc ? extractToc(doc.markdown) : []), [doc]);

  if (!doc) {
    return <Navigate to="/protocol" replace />;
  }

  return (
    <div className="page-root" data-testid={`docs-${doc.slug}-page`}>
      <TopBar />

      <main
        style={{
          maxWidth: 1080,
          margin: '0 auto',
          padding: '48px 24px 80px',
          display: 'grid',
          gridTemplateColumns: '220px 1fr',
          gap: 48,
          alignItems: 'start',
        }}
      >
        <aside
          style={{
            position: 'sticky',
            top: 72,
            display: 'block',
          }}
          className="protocol-toc"
        >
          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: 12,
            }}
          >
            Docs
          </p>
          <nav style={{ marginBottom: 24 }}>
            {DOCS.map((entry) => (
              <Link
                key={entry.slug}
                to={`/docs/${entry.slug}`}
                style={{
                  display: 'block',
                  fontSize: 13,
                  color: entry.slug === doc.slug ? 'var(--ink)' : 'var(--muted)',
                  textDecoration: 'none',
                  padding: '4px 0',
                  fontWeight: entry.slug === doc.slug ? 600 : 400,
                }}
              >
                {entry.label}
              </Link>
            ))}
          </nav>

          <p
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: 12,
            }}
          >
            Contents
          </p>
          <nav>
            {toc.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                style={{
                  display: 'block',
                  fontSize: 13,
                  color: 'var(--muted)',
                  textDecoration: 'none',
                  padding: '4px 0',
                  paddingLeft: item.level === 3 ? 12 : 0,
                  fontWeight: item.level === 1 ? 600 : 400,
                }}
              >
                {item.text}
              </a>
            ))}
          </nav>
        </aside>

        <article>
          <p
            style={{
              margin: '0 0 12px',
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--muted)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            Plain-language launch docs
          </p>

          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 8,
              marginBottom: 20,
            }}
          >
            {DOCS.map((entry) => (
              <Link
                key={entry.slug}
                to={`/docs/${entry.slug}`}
                style={{
                  fontSize: 12,
                  fontWeight: entry.slug === doc.slug ? 600 : 500,
                  color: entry.slug === doc.slug ? 'var(--ink)' : 'var(--muted)',
                  textDecoration: 'none',
                  padding: '6px 10px',
                  border: '1px solid var(--line)',
                  borderRadius: 999,
                  background: entry.slug === doc.slug ? 'var(--card)' : 'var(--bg)',
                }}
              >
                {entry.label}
              </Link>
            ))}
          </div>

          <button
            type="button"
            className="protocol-toc-toggle"
            onClick={() => setTocOpen((open) => !open)}
            style={{
              display: 'none',
              marginBottom: 20,
              padding: '8px 14px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 8,
              fontSize: 13,
              cursor: 'pointer',
              fontFamily: 'inherit',
              color: 'var(--ink)',
            }}
          >
            {tocOpen ? 'Hide contents' : 'Show contents'}
          </button>

          {tocOpen && (
            <div
              style={{
                display: 'none',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 10,
                padding: '16px 20px',
                marginBottom: 24,
              }}
              className="protocol-toc-mobile"
            >
              {toc.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  onClick={() => setTocOpen(false)}
                  style={{
                    display: 'block',
                    fontSize: 13,
                    color: 'var(--muted)',
                    textDecoration: 'none',
                    padding: '4px 0',
                    paddingLeft: item.level === 3 ? 12 : 0,
                    fontWeight: item.level === 1 ? 600 : 400,
                  }}
                >
                  {item.text}
                </a>
              ))}
            </div>
          )}

          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={markdownComponents as never}
          >
            {doc.markdown}
          </ReactMarkdown>

          <div
            style={{
              marginTop: 40,
              padding: '24px',
              background: 'var(--card)',
              border: '1px solid var(--line)',
              borderRadius: 12,
              display: 'flex',
              flexWrap: 'wrap',
              gap: 12,
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <p style={{ margin: '0 0 4px', fontSize: 14, fontWeight: 600 }}>
                Need the full reference?
              </p>
              <p style={{ margin: 0, fontSize: 13, color: 'var(--muted)' }}>
                Protocol, self-host, and pricing live next to these launch-week answers.
              </p>
            </div>
            <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Link
                to="/protocol"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '8px 16px',
                  background: 'var(--ink)',
                  color: '#fff',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  textDecoration: 'none',
                }}
              >
                Protocol
              </Link>
              <Link
                to="/pricing"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '8px 16px',
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 500,
                  textDecoration: 'none',
                  color: 'var(--ink)',
                }}
              >
                Pricing
              </Link>
              <a
                href="https://github.com/floomhq/floom/blob/main/docs/SELF_HOST.md"
                target="_blank"
                rel="noreferrer"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  padding: '8px 16px',
                  background: 'var(--card)',
                  border: '1px solid var(--line)',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 500,
                  textDecoration: 'none',
                  color: 'var(--ink)',
                }}
              >
                Self-host guide
              </a>
            </div>
          </div>
        </article>
      </main>
      <Footer />
      <FeedbackButton />
    </div>
  );
}
