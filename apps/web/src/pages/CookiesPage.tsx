// /cookies - cookie policy. Bilingual DE + EN. Describes the small set of
// strictly necessary + preference cookies Floom actually sets.

import { useState } from 'react';
import { PageShell } from '../components/PageShell';
import { LegalLangToggle, LegalPageHeader, LegalSection, type Lang } from '../components/LegalPageChrome';

interface Row {
  name: string;
  purpose_de: string;
  purpose_en: string;
  duration_de: string;
  duration_en: string;
  type_de: string;
  type_en: string;
}

const COOKIES: Row[] = [
  {
    name: '__Secure-fsid',
    purpose_de: 'Hält deine Login-Sitzung aufrecht.',
    purpose_en: 'Keeps you signed in.',
    duration_de: 'Bis zum Logout, max. 30 Tage',
    duration_en: 'Until logout, max 30 days',
    type_de: 'Technisch notwendig',
    type_en: 'Strictly necessary',
  },
  {
    name: 'floom.cookie-consent',
    purpose_de: 'Speichert deine Entscheidung zur Cookie-Auswahl.',
    purpose_en: 'Stores your cookie choice.',
    duration_de: '12 Monate',
    duration_en: '12 months',
    type_de: 'Technisch notwendig',
    type_en: 'Strictly necessary',
  },
  {
    name: 'floom.theme',
    purpose_de: 'Speichert dein Theme (hell/dunkel), sofern verfügbar.',
    purpose_en: 'Stores your theme preference (light/dark), when available.',
    duration_de: '12 Monate',
    duration_en: '12 months',
    type_de: 'Präferenz',
    type_en: 'Preference',
  },
];

function CookieTable({ lang }: { lang: Lang }) {
  const headers = lang === 'de'
    ? ['Name', 'Zweck', 'Dauer', 'Typ']
    : ['Name', 'Purpose', 'Duration', 'Type'];

  return (
    <div style={{ overflowX: 'auto' }}>
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 14,
          marginTop: 12,
        }}
      >
        <thead>
          <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--line)' }}>
            {headers.map((h) => (
              <th key={h} style={{ padding: '10px 12px', fontWeight: 700, color: 'var(--ink)' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {COOKIES.map((c) => (
            <tr key={c.name} style={{ borderBottom: '1px solid var(--line)' }}>
              <td style={{ padding: '10px 12px', fontFamily: 'JetBrains Mono, monospace', fontSize: 13 }}>
                {c.name}
              </td>
              <td style={{ padding: '10px 12px', color: 'var(--ink)' }}>
                {lang === 'de' ? c.purpose_de : c.purpose_en}
              </td>
              <td style={{ padding: '10px 12px', color: 'var(--muted)' }}>
                {lang === 'de' ? c.duration_de : c.duration_en}
              </td>
              <td style={{ padding: '10px 12px', color: 'var(--muted)' }}>
                {lang === 'de' ? c.type_de : c.type_en}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CookiesPage() {
  // UX sweep 2026-04-24 (issue #704): Floom Inc. is a Delaware C-Corp,
  // so the policy should open in English by default, not German. The DE
  // copy stays fully translated, users can flip via LegalLangToggle.
  const [lang, setLang] = useState<Lang>('en');

  return (
    <PageShell title="Cookies · Floom">
      <article style={{ maxWidth: 720, margin: '0 auto' }}>
        <LegalLangToggle lang={lang} onChange={setLang} />
        <LegalPageHeader
          title={lang === 'de' ? 'Cookie-Richtlinie' : 'Cookie Policy'}
          updated="2026-04-20"
          lang={lang}
        />

        {lang === 'de' ? (
          <>
            <LegalSection id="was" title="Was sind Cookies?">
              <p>
                Cookies sind kleine Textdateien, die auf deinem Gerät gespeichert werden, wenn du eine
                Website besuchst. Sie ermöglichen es zum Beispiel, dass du eingeloggt bleibst oder deine
                Präferenzen zwischen Besuchen erhalten bleiben.
              </p>
            </LegalSection>

            <LegalSection id="welche" title="Welche Cookies Floom setzt">
              <p>
                Wir setzen ausschließlich technisch notwendige und Präferenz-Cookies. Wir binden derzeit
                keine Analyse-, Tracking- oder Werbe-Cookies ein.
              </p>
              <CookieTable lang="de" />
            </LegalSection>

            <LegalSection id="einwilligung" title="Einwilligung und Widerruf">
              <p>
                Technisch notwendige Cookies setzen wir ohne Einwilligung, da sie für den Betrieb der
                Seite erforderlich sind (z. B. um dich eingeloggt zu halten). Sollten wir zukünftig
                Cookies einsetzen, die eine Einwilligung erfordern (z. B. Analyse), fragen wir diese über
                den Cookie-Banner ab. Du kannst eine einmal erteilte Einwilligung jederzeit widerrufen,
                indem du den Banner erneut aufrufst oder die Cookies in deinem Browser löschst.
              </p>
            </LegalSection>

            <LegalSection id="browser" title="Cookies im Browser verwalten">
              <p>
                Du kannst Cookies in deinem Browser jederzeit löschen oder deren Speicherung einschränken.
                Eine Einschränkung kann dazu führen, dass Teile von Floom (z. B. Login) nicht mehr
                funktionieren.
              </p>
            </LegalSection>
          </>
        ) : (
          <>
            <LegalSection id="what" title="What are cookies?">
              <p>
                Cookies are small text files stored on your device when you visit a website. They enable
                basic functions such as keeping you signed in or preserving your preferences across
                visits.
              </p>
            </LegalSection>

            <LegalSection id="which" title="Which cookies Floom sets">
              <p>
                We only set strictly necessary and preference cookies. We currently do not embed any
                analytics, tracking, or advertising cookies.
              </p>
              <CookieTable lang="en" />
            </LegalSection>

            <LegalSection id="consent" title="Consent and withdrawal">
              <p>
                Strictly necessary cookies are set without consent because they are required to operate
                the site (for example keeping you signed in). If we introduce cookies that require consent
                (for example analytics), we will ask for it via the cookie banner. You can withdraw
                consent at any time by reopening the banner or clearing cookies in your browser.
              </p>
            </LegalSection>

            <LegalSection id="browser" title="Managing cookies in your browser">
              <p>
                You can delete cookies or restrict their storage in your browser at any time. Restricting
                them may cause parts of Floom (such as login) to stop working.
              </p>
            </LegalSection>
          </>
        )}
      </article>
    </PageShell>
  );
}
