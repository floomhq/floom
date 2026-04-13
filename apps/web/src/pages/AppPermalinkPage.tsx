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

  // SEO meta — update document head
  useEffect(() => {
    if (!app) return;
    document.title = `${app.name} — Floom`;
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
    setMeta('og:title', `${app.name} — Floom`, true);
    setMeta('og:description', app.description, true);
    setMeta('og:url', `https://preview.floom.dev/p/${app.slug}`, true);
    setMeta('og:type', 'website', true);

    // JSON-LD SoftwareApplication schema
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
      author: {
        '@type': 'Person',
        name: app.author || 'floomhq',
      },
    });
    document.head.appendChild(script);

    return () => {
      document.title = 'Floom — infra for agentic work';
      const s = document.getElementById('jsonld-app');
      if (s) s.remove();
    };
  }, [app]);

  const handleSignIn = () => {
    // stub
  };

  if (loading) {
    return (
      <div className="page-root">
        <TopBar onSignIn={handleSignIn} />
        <main className="main" style={{ paddingTop: 80, textAlign: 'center' }}>
          <p style={{ color: 'var(--muted)', fontSize: 14 }}>Loading…</p>
        </main>
        <Footer />
      </div>
    );
  }

  if (notFound || !app) {
    return (
      <div className="page-root">
        <TopBar onSignIn={handleSignIn} />
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

  return (
    <div className="page-root">
      <TopBar onSignIn={handleSignIn} />

      <main
        className="main"
        style={{ paddingTop: 48, paddingBottom: 80, maxWidth: 720, margin: '0 auto' }}
        data-testid="permalink-page"
      >
        {/* Breadcrumb */}
        <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
          <Link
            to="/apps"
            style={{ fontSize: 13, color: 'var(--muted)', textDecoration: 'none' }}
          >
            Apps
          </Link>
          <span style={{ color: 'var(--muted)', fontSize: 13 }}>/</span>
          <span style={{ fontSize: 13, color: 'var(--ink)', fontWeight: 500 }}>{app.name}</span>
        </div>

        {/* Standalone FloomApp */}
        <FloomApp
          app={app}
          standalone={true}
          showSidebar={true}
        />

        {/* Share footer */}
        <div
          style={{
            marginTop: 40,
            padding: '20px 24px',
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
            <p style={{ margin: 0, fontSize: 13, fontWeight: 600, color: 'var(--ink)' }}>
              Share this app
            </p>
            <code
              style={{
                fontSize: 12,
                fontFamily: 'JetBrains Mono, monospace',
                color: 'var(--muted)',
                marginTop: 4,
                display: 'block',
              }}
            >
              {permalinkUrl}
            </code>
          </div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <CopyButton text={permalinkUrl} />
            <a
              href={`https://twitter.com/intent/tweet?text=${encodeURIComponent(`Try ${app.name} on Floom — ${app.description}`)}&url=${encodeURIComponent(permalinkUrl)}`}
              target="_blank"
              rel="noreferrer"
              style={{
                padding: '8px 16px',
                background: 'var(--card)',
                border: '1px solid var(--line)',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
                color: 'var(--ink)',
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
              }}
            >
              Share on X
            </a>
            <Link
              to={`/chat?app=${app.slug}`}
              style={{
                padding: '8px 16px',
                background: 'var(--accent)',
                color: '#fff',
                borderRadius: 8,
                fontSize: 13,
                fontWeight: 600,
                textDecoration: 'none',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              Try in chat →
            </Link>
          </div>
        </div>
      </main>
      <Footer />
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <button
      type="button"
      onClick={handleCopy}
      style={{
        padding: '8px 16px',
        background: 'var(--card)',
        border: '1px solid var(--line)',
        borderRadius: 8,
        fontSize: 13,
        fontWeight: 500,
        cursor: 'pointer',
        fontFamily: 'inherit',
        color: copied ? 'var(--success)' : 'var(--ink)',
        transition: 'color 0.15s',
      }}
    >
      {copied ? 'Copied!' : 'Copy link'}
    </button>
  );
}
