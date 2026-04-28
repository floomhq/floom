// /privacy — privacy policy / Datenschutzerklärung.
//
// Floom, Inc. is a Delaware C-Corp but ships to EU users, so GDPR still
// applies to personal data of EU data subjects. Bilingual DE + EN is kept
// because EU residents are used to seeing a native-language privacy notice.
// Controller is the US entity; transfers to the US rely on Standard
// Contractual Clauses.

import { useState } from 'react';
import { PageShell } from '../components/PageShell';
import { LegalLangToggle, LegalPageHeader, LegalSection, type Lang } from '../components/LegalPageChrome';

export function PrivacyPage() {
  const [lang, setLang] = useState<Lang>('en');

  return (
    <PageShell title="Privacy · Floom">
      <article style={{ maxWidth: 720, margin: '0 auto' }}>
        <LegalLangToggle lang={lang} onChange={setLang} />
        <LegalPageHeader
          title={lang === 'de' ? 'Datenschutzerklärung' : 'Privacy Policy'}
          updated="2026-04-20"
          lang={lang}
        />

        {lang === 'de' ? (
          <>
            <LegalSection id="verantwortlicher" title="1. Verantwortlicher">
              <p>
                Verantwortlicher im Sinne der Datenschutz-Grundverordnung (DSGVO):
                <br />
                <strong>Floom, Inc.</strong>
                <br />
                1207 Delaware Ave, Suite 226
                <br />
                Wilmington, DE 19806, USA
                <br />
                E-Mail: <a href="mailto:team@floom.dev">team@floom.dev</a>
              </p>
            </LegalSection>

            <LegalSection id="daten" title="2. Welche Daten wir verarbeiten">
              <p>Beim Betrieb von Floom verarbeiten wir folgende Kategorien personenbezogener Daten:</p>
              <ul>
                <li>Konto-Daten: E-Mail-Adresse und Passwort-Hash (für Authentifizierung).</li>
                <li>Nutzungsdaten: Ausführungshistorie von Apps (Run-Logs, Eingaben, Ergebnisse) sowie API-Schlüssel, die du in dein Konto einträgst.</li>
                <li>Technische Daten: IP-Adresse (für Rate-Limiting und Missbrauchsabwehr), User-Agent, Zeitstempel, Device-ID-Cookie für anonyme Sessions.</li>
                <li>Kommunikationsdaten: Inhalt deiner Support-Anfragen, sofern du uns kontaktierst.</li>
                <li>Zahlungsdaten (zukünftig): bei kostenpflichtigen Plänen über einen externen Zahlungsdienstleister.</li>
              </ul>
            </LegalSection>

            <LegalSection id="rechtsgrundlage" title="3. Rechtsgrundlage">
              <p>
                Wir verarbeiten personenbezogene Daten auf Grundlage von Art. 6 Abs. 1 lit. b DSGVO
                (Erfüllung des Nutzungsvertrags für angemeldete Funktionen), Art. 6 Abs. 1 lit. f DSGVO
                (berechtigtes Interesse an sicherem Betrieb, Missbrauchsabwehr und anonymen Sessions) und,
                wo erforderlich, Art. 6 Abs. 1 lit. a DSGVO (Einwilligung, z. B. für optionale Cookies).
              </p>
            </LegalSection>

            <LegalSection id="speicherdauer" title="4. Speicherdauer">
              <p>
                Konto-Daten werden gespeichert, solange dein Konto besteht. Run-Logs werden standardmäßig
                90 Tage aufbewahrt. Session-Cookies laufen spätestens nach 30 Tagen ab. Du kannst jederzeit
                einzelne Runs löschen oder dein Konto über die Einstellungen vollständig entfernen.
              </p>
            </LegalSection>

            <LegalSection id="dritte" title="5. Auftragsverarbeiter und Drittanbieter">
              <p>Zum Betrieb von Floom nutzen wir sorgfältig ausgewählte Dienstleister, z. B.:</p>
              <ul>
                <li>Infrastruktur- und Hosting-Anbieter für Server und Datenbank in der EU.</li>
                <li>LLM-Anbieter (OpenAI, Google), wenn eine Floom-App KI-Funktionen aufruft. Eingaben werden dabei an den Modellanbieter übertragen, um das Ergebnis zu berechnen.</li>
                <li>SMTP-Dienstleister für transaktionale E-Mails (z. B. Passwort-Reset).</li>
                <li>Fehler- und Performance-Monitoring, sofern aktiviert.</li>
                <li>Zahlungsdienstleister (geplant, für kostenpflichtige Pläne).</li>
              </ul>
              <p>
                Mit Auftragsverarbeitern schließen wir Verträge nach Art. 28 DSGVO. Bei Übermittlungen in
                Drittländer, insbesondere in die USA, stützen wir uns auf Standardvertragsklauseln (SCCs)
                gemäß Art. 46 DSGVO sowie angemessene technische und organisatorische Maßnahmen.
              </p>
            </LegalSection>

            <LegalSection id="drittlaender" title="6. Übermittlung in die USA">
              <p>
                Floom, Inc. hat ihren Sitz in den USA. Kontodaten und Run-Logs können auf US-Infrastruktur
                gespeichert oder dorthin übertragen werden. Wir setzen dafür Standardvertragsklauseln
                (SCCs) ein und prüfen regelmäßig, ob zusätzliche Schutzmaßnahmen erforderlich sind.
              </p>
            </LegalSection>

            <LegalSection id="rechte" title="7. Deine Rechte">
              <p>Als betroffene Person hast du das Recht auf:</p>
              <ul>
                <li>Auskunft über die zu deiner Person gespeicherten Daten (Art. 15 DSGVO).</li>
                <li>Berichtigung unrichtiger Daten (Art. 16 DSGVO).</li>
                <li>Löschung, sofern keine gesetzlichen Aufbewahrungspflichten entgegenstehen (Art. 17 DSGVO).</li>
                <li>Einschränkung der Verarbeitung (Art. 18 DSGVO).</li>
                <li>Datenübertragbarkeit (Art. 20 DSGVO).</li>
                <li>Widerspruch gegen Verarbeitung auf Grundlage berechtigter Interessen (Art. 21 DSGVO).</li>
                <li>Beschwerde bei einer EU-Datenschutzaufsichtsbehörde, z. B. in deinem Wohnsitzland.</li>
              </ul>
              <p>
                Für alle Anfragen wende dich an{' '}
                <a href="mailto:team@floom.dev">team@floom.dev</a>. Die Kontolöschung ist zusätzlich
                direkt über die Einstellungen verfügbar.
              </p>
            </LegalSection>

            <LegalSection id="cookies" title="8. Cookies">
              <p>
                Floom verwendet nur technisch notwendige Cookies und eine einfache Präferenz-Cookie.
                Details findest du in der <a href="/cookies">Cookie-Richtlinie</a>.
              </p>
            </LegalSection>

            <LegalSection id="aenderungen" title="9. Änderungen dieser Erklärung">
              <p>
                Diese Datenschutzerklärung kann angepasst werden, etwa bei neuen Features oder neuen
                Dienstleistern. Die jeweils aktuelle Version ist unter dieser URL abrufbar; das Datum oben
                zeigt den letzten Stand.
              </p>
            </LegalSection>
          </>
        ) : (
          <>
            <LegalSection id="controller" title="1. Controller">
              <p>
                The controller under the General Data Protection Regulation (GDPR):
                <br />
                <strong>Floom, Inc.</strong>
                <br />
                1207 Delaware Ave, Suite 226
                <br />
                Wilmington, DE 19806, United States
                <br />
                Email: <a href="mailto:team@floom.dev">team@floom.dev</a>
              </p>
            </LegalSection>

            <LegalSection id="data" title="2. What data we process">
              <p>Operating Floom involves processing the following categories of personal data:</p>
              <ul>
                <li>Account data: email address and password hash (for authentication).</li>
                <li>Usage data: app run history (run logs, inputs, outputs) and BYOK keys added in Workspace settings.</li>
                <li>Technical data: IP address (for rate limiting and abuse prevention), user agent, timestamps, and a device-ID cookie for anonymous sessions.</li>
                <li>Communications: the content of any support request you send us.</li>
                <li>Payment data (future): handled by a third-party payment processor for paid plans.</li>
              </ul>
            </LegalSection>

            <LegalSection id="basis" title="3. Legal basis">
              <p>
                We process personal data on the basis of Art. 6 (1) (b) GDPR (performance of the user
                agreement, for signed-in services), Art. 6 (1) (f) GDPR (legitimate interest in secure
                operation, abuse prevention, and anonymous session handling), and, where required,
                Art. 6 (1) (a) GDPR (consent, for example for optional cookies).
              </p>
            </LegalSection>

            <LegalSection id="retention" title="4. Retention">
              <p>
                Account data is retained while the account exists. Run logs are kept for 90 days by
                default. Session cookies expire after 30 days at the latest. You can delete individual
                runs at any time or remove the account entirely from Account settings.
              </p>
            </LegalSection>

            <LegalSection id="third-parties" title="5. Processors and sub-processors">
              <p>We rely on carefully selected service providers to operate Floom, including:</p>
              <ul>
                <li>Infrastructure and hosting providers for servers and database in the EU.</li>
                <li>LLM providers (OpenAI, Google) when a Floom app calls AI features. Inputs are transmitted to the model provider to compute the result.</li>
                <li>An SMTP provider for transactional email (for example password reset).</li>
                <li>Error and performance monitoring, when enabled.</li>
                <li>A payment processor (planned, for paid plans).</li>
              </ul>
              <p>
                We conclude data processing agreements under Art. 28 GDPR with our processors. For
                transfers to third countries, in particular the United States, we rely on Standard
                Contractual Clauses (SCCs) under Art. 46 GDPR and appropriate technical and organizational
                measures.
              </p>
            </LegalSection>

            <LegalSection id="us-transfers" title="6. Transfers to the United States">
              <p>
                Floom, Inc. is a US entity. Account data and run logs may be stored on or transferred to
                US infrastructure. We use Standard Contractual Clauses (SCCs) for these transfers and
                review the arrangements periodically to confirm whether additional safeguards are
                required.
              </p>
            </LegalSection>

            <LegalSection id="rights" title="7. Your rights">
              <p>As a data subject you have the right to:</p>
              <ul>
                <li>Access the personal data we hold about you (Art. 15 GDPR).</li>
                <li>Rectify inaccurate data (Art. 16 GDPR).</li>
                <li>Erasure, unless statutory retention obligations apply (Art. 17 GDPR).</li>
                <li>Restrict processing (Art. 18 GDPR).</li>
                <li>Data portability (Art. 20 GDPR).</li>
                <li>Object to processing based on legitimate interests (Art. 21 GDPR).</li>
                <li>Lodge a complaint with a supervisory authority in the EU member state of your residence.</li>
              </ul>
              <p>
                For any request, contact <a href="mailto:team@floom.dev">team@floom.dev</a>. Account
                deletion is also available directly from Account settings.
              </p>
            </LegalSection>

            <LegalSection id="cookies" title="8. Cookies">
              <p>
                Floom only uses strictly necessary cookies and a single preference cookie. See the{' '}
                <a href="/cookies">cookie policy</a> for details.
              </p>
            </LegalSection>

            <LegalSection id="changes" title="9. Changes to this policy">
              <p>
                This policy may be updated, for example when new features or new service providers are
                introduced. The current version is always available at this URL; the date at the top
                reflects the latest revision.
              </p>
            </LegalSection>
          </>
        )}
      </article>
    </PageShell>
  );
}
