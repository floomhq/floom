// Shared chrome for legal pages: lang toggle, page header with "preliminary
// draft" notice + last-updated date, and an h2-anchored section wrapper.
// Kept small and style-system-native (CSS vars, no new deps).

import type { ReactNode } from 'react';

export type Lang = 'de' | 'en';

interface ToggleProps {
  lang: Lang;
  onChange: (next: Lang) => void;
}

export function LegalLangToggle({ lang, onChange }: ToggleProps) {
  const btn = (value: Lang, label: string) => (
    <button
      key={value}
      type="button"
      onClick={() => onChange(value)}
      aria-pressed={lang === value}
      style={{
        fontSize: 12,
        padding: '6px 12px',
        borderRadius: 999,
        border: '1px solid var(--line)',
        background: lang === value ? 'var(--accent)' : 'var(--card)',
        color: lang === value ? '#fff' : 'var(--muted)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontWeight: 600,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
      }}
    >
      {label}
    </button>
  );

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        justifyContent: 'flex-end',
        marginBottom: 16,
      }}
      role="group"
      aria-label="Language"
    >
      {btn('de', 'DE')}
      {btn('en', 'EN')}
    </div>
  );
}

interface HeaderProps {
  title: string;
  updated: string;
  lang: Lang;
}

export function LegalPageHeader({ title, updated, lang }: HeaderProps) {
  const notice =
    lang === 'de'
      ? 'Dies ist ein vorläufiger Entwurf. Eine anwaltlich geprüfte Fassung wird vor dem kostenpflichtigen Start veröffentlicht.'
      : 'This is a preliminary draft. A reviewed version will be published before paid launch.';
  const updatedLabel = lang === 'de' ? 'Letzte Aktualisierung' : 'Last updated';

  return (
    <header style={{ marginBottom: 32 }}>
      <h1 style={{ fontSize: 40, fontWeight: 700, margin: '0 0 8px', color: 'var(--ink)' }}>
        {title}
      </h1>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px' }}>
        {updatedLabel}: <time dateTime={updated}>{updated}</time>
      </p>
      <div
        style={{
          padding: '12px 16px',
          background: 'rgba(5, 150, 105, 0.08)',
          border: '1px solid rgba(5, 150, 105, 0.25)',
          borderRadius: 8,
          fontSize: 13,
          color: 'var(--ink)',
          lineHeight: 1.5,
        }}
      >
        {notice}
      </div>
    </header>
  );
}

interface SectionProps {
  id: string;
  title: string;
  children: ReactNode;
}

export function LegalSection({ id, title, children }: SectionProps) {
  return (
    <section
      id={id}
      style={{
        marginBottom: 32,
        fontSize: 15,
        lineHeight: 1.7,
        color: 'var(--ink)',
      }}
    >
      <h2
        style={{
          fontSize: 20,
          fontWeight: 700,
          margin: '0 0 12px',
          color: 'var(--ink)',
          scrollMarginTop: 80,
        }}
      >
        <a
          href={`#${id}`}
          style={{ color: 'inherit', textDecoration: 'none' }}
          aria-label={`Link to section: ${title}`}
        >
          {title}
        </a>
      </h2>
      <div className="legal-section-body" style={{ color: 'var(--ink)' }}>
        {children}
      </div>
    </section>
  );
}
