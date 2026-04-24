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
  // Launch-audit 2026-04-24 (P1 #617): the "preliminary draft, reviewed
  // version will be published before paid launch" banner shipped above
  // every legal page. On launch day that signals "our legal text might
  // be wrong" to the first impression a visitor gets, so the banner is
  // removed. Lawyer review remains a post-launch track (ref #113) and
  // will add a softer notice back if/when it warrants one.
  const updatedLabel = lang === 'de' ? 'Letzte Aktualisierung' : 'Last updated';

  return (
    <header style={{ marginBottom: 32 }}>
      <h1
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: 40,
          fontWeight: 800,
          letterSpacing: '-0.025em',
          lineHeight: 1.1,
          margin: '0 0 8px',
          color: 'var(--ink)',
        }}
      >
        {title}
      </h1>
      <p style={{ fontSize: 13, color: 'var(--muted)', margin: '0 0 16px' }}>
        {updatedLabel}: <time dateTime={updated}>{updated}</time>
      </p>
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
          fontFamily: 'var(--font-display)',
          fontSize: 20,
          fontWeight: 700,
          letterSpacing: '-0.015em',
          lineHeight: 1.2,
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
