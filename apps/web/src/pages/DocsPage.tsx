import { useMemo, useState } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { FeedbackButton } from '../components/FeedbackButton';
import { PageHead } from '../components/PageHead';
import {
  extractToc,
  markdownComponents,
} from '../components/docs/markdown';
import { DocsSidebar, DOCS_SIDEBAR_GROUPS } from '../components/docs/DocsSidebar';
import { DocsPublishWaitlistBanner } from '../components/docs/DocsPublishWaitlistBanner';
import limitsMd from '../assets/docs/limits.md?raw';
import securityMd from '../assets/docs/security.md?raw';
import observabilityMd from '../assets/docs/observability.md?raw';
import workflowMd from '../assets/docs/workflow.md?raw';
import ownershipMd from '../assets/docs/ownership.md?raw';
import reliabilityMd from '../assets/docs/reliability.md?raw';
import pricingMd from '../assets/docs/pricing.md?raw';
// v17 Docs hub rebuild (2026-04-22). Four new MECE sections with real
// content sourced from the server routes, self-host docs, and manifest
// spec — no lorem ipsum, no "TBD".
import mcpInstallMd from '../assets/docs/mcp-install.md?raw';
import selfHostMd from '../assets/docs/self-host.md?raw';
import runtimeSpecsMd from '../assets/docs/runtime-specs.md?raw';
import cliMd from '../assets/docs/cli.md?raw';
import apiReferenceMd from '../assets/docs/api-reference.md?raw';
import quickstartMd from '../assets/docs/quickstart.md?raw';

const DOCS = [
  // v17 hub slugs (2026-04-22). Real routes reachable via DocsSidebar.
  // Quickstart is the canonical "first app in 5 min" walkthrough (#306).
  { slug: 'quickstart', label: 'Quickstart', markdown: quickstartMd },
  { slug: 'mcp-install', label: 'MCP install', markdown: mcpInstallMd },
  { slug: 'cli', label: 'CLI', markdown: cliMd },
  { slug: 'runtime-specs', label: 'Runtime specs', markdown: runtimeSpecsMd },
  { slug: 'self-host', label: 'Self-host', markdown: selfHostMd },
  { slug: 'api-reference', label: 'API reference', markdown: apiReferenceMd },
  // Existing launch-week answers (kept — referenced from the sidebar
  // Limits / Runtime / Deploy groups).
  { slug: 'limits', label: 'Runtime & limits', markdown: limitsMd },
  { slug: 'security', label: 'Security', markdown: securityMd },
  { slug: 'observability', label: 'Observability', markdown: observabilityMd },
  { slug: 'workflow', label: 'Workflow', markdown: workflowMd },
  { slug: 'ownership', label: 'Ownership', markdown: ownershipMd },
  { slug: 'reliability', label: 'Reliability', markdown: reliabilityMd },
  { slug: 'pricing', label: 'Pricing', markdown: pricingMd },
] as const;

type DocEntry = (typeof DOCS)[number];

/**
 * Lift the first real paragraph from a markdown doc and trim it to ~160
 * chars for <meta name="description">. Strips code fences, headings,
 * list markers, and link syntax. Falls back to a generic sentence that
 * names the page, so empty or code-fence-first docs still get something.
 */
function extractDescription(md: string, label: string): string {
  const fallback = `${label} reference on Floom — protocol, runtime, and launch notes.`;
  if (!md) return fallback;
  const stripped = md
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^---[\s\S]*?---\n/m, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('|'))
    .join(' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!stripped) return fallback;
  if (stripped.length <= 160) return stripped;
  const clipped = stripped.slice(0, 157);
  const lastSpace = clipped.lastIndexOf(' ');
  return (lastSpace > 100 ? clipped.slice(0, lastSpace) : clipped) + '…';
}

export function DocsPage() {
  const { slug } = useParams<{ slug: string }>();
  const { pathname } = useLocation();
  const doc = DOCS.find((entry) => entry.slug === slug) as DocEntry | undefined;
  const [tocOpen, setTocOpen] = useState(false);

  const toc = useMemo(() => (doc ? extractToc(doc.markdown) : []), [doc]);

  if (!doc) {
    return <Navigate to="/docs" replace />;
  }

  // Lift a ~160-char description from the first markdown paragraph so each
  // /docs/:slug page has a meaningful <meta description> instead of
  // inheriting the landing page copy.
  const description = extractDescription(doc.markdown, doc.label);

  return (
    <div className="page-root" data-testid={`docs-${doc.slug}-page`}>
      <PageHead
        title={`${doc.label} · Floom Docs`}
        description={description}
      />
      <TopBar />
      <DocsPublishWaitlistBanner />

      <main
        style={{
          maxWidth: 1260,
          margin: '0 auto',
          padding: '0',
          display: 'grid',
          gridTemplateColumns: '260px minmax(0, 1fr)',
          gap: 0,
          alignItems: 'start',
        }}
      >
        {/* Shared v17 sidebar. Same groups on /docs and every /docs/:slug. */}
        <DocsSidebar groups={DOCS_SIDEBAR_GROUPS} currentPath={pathname} />

        <article style={{ padding: '44px 48px 80px', minWidth: 0 }}>
          {toc.length > 0 ? (
            <nav style={{ marginBottom: 24 }} aria-label="On-page contents">
              <p
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.08em',
                  marginBottom: 8,
                }}
              >
                On this page
              </p>
              {toc.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  style={{
                    display: 'inline-block',
                    marginRight: 12,
                    fontSize: 12,
                    color: 'var(--muted)',
                    textDecoration: 'none',
                    paddingLeft: item.level === 3 ? 12 : 0,
                  }}
                >
                  {item.text}
                </a>
              ))}
            </nav>
          ) : null}
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
              {/* PR #408 ripple (2026-04-22): self-host doc is now internal
                  at /docs/self-host — swap the external GitHub blob link
                  so readers stay in the app and the sidebar stays in sync. */}
              <Link
                to="/docs/self-host"
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
              </Link>
            </div>
          </div>
        </article>
      </main>
      <Footer />
      <FeedbackButton />
    </div>
  );
}
