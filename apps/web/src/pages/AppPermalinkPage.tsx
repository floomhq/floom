import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { TopBar } from '../components/TopBar';
import { Footer } from '../components/Footer';
import { FloomApp } from '../components/FloomApp';
import { getApp } from '../api/client';
import type { AppDetail } from '../lib/types';

export function AppPermalinkPage() {
  const { slug } = useParams<{ slug: string }>();
  const [app, setApp] = useState<AppDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!slug) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    getApp(slug)
      .then((a) => {
        setApp(a);
        setLoading(false);
      })
      .catch(() => {
        setNotFound(true);
        setLoading(false);
      });
  }, [slug]);

  // SEO meta
  useEffect(() => {
    if (!app) return;
    document.title = `${app.name} | Floom`;
    const setMeta = (name: string, content: string, prop = false) => {
      const attr = prop ? 'property' : 'name';
      let el = document.querySelector(`meta[${attr}="${name}"]`);
      if (!el) {
        el = document.createElement('meta');
        el.setAttribute(attr, name);
        document.head.appendChild(el);
      }
      el.setAttribute('content', content);
    };
    setMeta('description', app.description);
    setMeta('og:title', `${app.name} | Floom`, true);
    setMeta('og:description', app.description, true);
    setMeta('og:url', `https://preview.floom.dev/p/${app.slug}`, true);
    setMeta('og:type', 'website', true);

    const existing = document.getElementById('jsonld-app');
    if (existing) existing.remove();
    const script = document.createElement('script');
    script.id = 'jsonld-app';
    script.type = 'application/ld+json';
    script.textContent = JSON.stringify({
      '@context': 'https://schema.org',
      '@type': 'SoftwareApplication',
      name: app.name,
      description: app.description,
      applicationCategory: app.category || 'UtilitiesApplication',
      url: `https://preview.floom.dev/p/${app.slug}`,
      author: { '@type': 'Person', name: app.author || 'floomhq' },
    });
    document.head.appendChild(script);

    return () => {
      document.title = 'Floom: infra for agentic work';
      const s = document.getElementById('jsonld-app');
      if (s) s.remove();
    };
  }, [app]);

  if (loading) {
    return (
      <div className="page-root">
        <TopBar />
        <main className="main" style={{ paddingTop: 80, textAlign: 'center' }}>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading...</p>
        </main>
        <Footer />
      </div>
    );
  }

  if (notFound || !app) {
    return (
      <div className="page-root">
        <TopBar />
        <main className="main" style={{ paddingTop: 80, textAlign: 'center', maxWidth: 480, margin: '0 auto' }}>
          <h1 style={{ fontSize: 32, fontWeight: 700, margin: '0 0 12px' }}>404</h1>
          <p style={{ color: 'var(--muted)', fontSize: 16, margin: '0 0 32px' }}>
            No app found at <code style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>/p/{slug}</code>
          </p>
          <Link
            to="/apps"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '10px 20px',
              background: 'var(--accent)',
              color: '#fff',
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            Back to all apps
          </Link>
        </main>
        <Footer />
      </div>
    );
  }

  const permalinkUrl = `https://preview.floom.dev/p/${app.slug}`;
  const mcpEndpoint = `https://preview.floom.dev/mcp/app/${app.slug}`;
  const httpEndpoint = `https://preview.floom.dev/api/run`;
  const cliExample = `floom run ${app.slug}`;

  return (
    <div className="page-root">
      <TopBar />

      <main
        style={{ padding: '36px 24px 80px', maxWidth: 1200, margin: '0 auto' }}
        data-testid="permalink-page"
      >
        {/* Breadcrumb */}
        <div style={{ marginBottom: 28, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Link
            to="/apps"
            style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 4 }}
          >
            All apps
          </Link>
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>/</span>
          <span style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 500 }}>{app.name}</span>
        </div>

        {/* 2-column layout: inputs left, output right */}
        <div className="permalink-2col">
          {/* Left: form */}
          <div>
            <FloomApp
              app={app}
              standalone={true}
              showSidebar={true}
            />
          </div>

          {/* Right: endpoints panel */}
          <div style={{ paddingTop: 0 }}>
            <div
              style={{
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 12,
                padding: '20px 24px',
                position: 'sticky',
                top: 72,
              }}
            >
              <p style={{ margin: '0 0 16px', fontSize: 13, fontWeight: 700, color: 'var(--ink)' }}>
                Access this app
              </p>

              <EndpointRow label="MCP" value={mcpEndpoint} />
              <EndpointRow label="HTTP" value={httpEndpoint} />
              <EndpointRow label="CLI" value={cliExample} />
              <EndpointRow label="Link" value={permalinkUrl} />

              <div style={{ borderTop: '1px solid var(--line)', paddingTop: 16, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <a
                  href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`Try ${app.name} on Floom. ${app.description}`)}&url=${encodeURIComponent(permalinkUrl)}`}
                  target="_blank"
                  rel="noreferrer"
                  style={{
                    padding: '7px 14px',
                    background: 'var(--bg)',
                    border: '1px solid var(--line)',
                    borderRadius: 7,
                    fontSize: 12,
                    fontWeight: 500,
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    color: 'var(--ink)',
                    textDecoration: 'none',
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                  }}
                >
                  Share on X
                </a>
              </div>
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function EndpointRow({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    try { navigator.clipboard.writeText(value).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); } catch { /* ignore */ }
  };
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.07em' }}>{label}</span>
        <button
          type="button"
          onClick={handleCopy}
          style={{
            fontSize: 10,
            padding: '2px 8px',
            background: 'var(--bg)',
            border: '1px solid var(--line)',
            borderRadius: 4,
            cursor: 'pointer',
            fontFamily: 'inherit',
            color: copied ? 'var(--success, #16a34a)' : 'var(--muted)',
            transition: 'color 0.15s',
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <code
        style={{
          display: 'block',
          fontSize: 11,
          fontFamily: 'JetBrains Mono, monospace',
          color: 'var(--ink)',
          background: 'var(--bg)',
          border: '1px solid var(--line)',
          borderRadius: 6,
          padding: '6px 10px',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {value}
      </code>
    </div>
  );
}
