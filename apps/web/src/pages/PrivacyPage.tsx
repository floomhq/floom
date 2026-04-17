// /privacy - privacy policy / Datenschutzerklärung. GDPR + DSGVO baseline.
// Bilingual DE + EN stub. Preliminary draft pending lawyer review.

import { useState } from 'react';
import { PageShell } from '../components/PageShell';
import { LegalLangToggle, LegalPageHeader, LegalSection, type Lang } from '../components/LegalPageChrome';

export function PrivacyPage() {
  const [lang, setLang] = useState<Lang>('de');

  return (
    <PageShell title="Privacy · Floom">
      <article style={{ maxWidth: 720, margin: '0 auto' }}>
        <LegalLangToggle lang={lang} onChange={setLang} />
        <LegalPageHeader
          title={lang === 'de' ? 'Datenschutzerklärung' : 'Privacy Policy'}
          updated="2026-04-17"
          lang={lang}
        />

        {lang === 'de' ? (
          <>
            <LegalSection id="verantwortlicher" title="1. Verantwortlicher">
              <p>
                Verantwortlich im Sinne der Datenschutz-Grundverordnung (DSGVO):
                <br />
                Federico De Ponte, Mansteinstraße 27, 20253 Hamburg, Deutschland
                <br />
                E-Mail: <a href="mailto:depontefede@gmail.com">depontefede@gmail.com</a>
              </p>
            </LegalSection>

            <LegalSection id="daten" title="2. Welche Daten wir erheben">
              <p>Beim Betrieb von Floom verarbeiten wir folgende Kategorien personenbezogener Daten:</p>
              <ul>
                <li>Konto-Daten: E-Mail-Adresse und Passwort-Hash (für Authentifizierung via Better Auth).</li>
                <li>Nutzungsdaten: Ausführungshistorie von Apps (Run-Logs, Eingaben, Ergebnisse), API-Schlüssel, die du in dein Konto einträgst.</li>
                <li>Technische Daten: IP-Adresse (für Rate-Limiting und Abwehr von Missbrauch), User-Agent, Zeitstempel.</li>
                <li>Zahlungsdaten (zukünftig): bei kostenpflichtigen Plänen über Stripe. Stripe ist dann eigenständig verantwortlich für die Zahlungsdaten.</li>
              </ul>
            </LegalSection>

            <LegalSection id="rechtsgrundlage" title="3. Rechtsgrundlage">
              <p>
                Wir verarbeiten personenbezogene Daten auf Grundlage von Art. 6 Abs. 1 lit. b DSGVO (Erfüllung
                des Nutzungsvertrags), Art. 6 Abs. 1 lit. f DSGVO (berechtigtes Interesse an sicherem Betrieb
                und Missbrauchsabwehr) und, wo erforderlich, Art. 6 Abs. 1 lit. a DSGVO (Einwilligung, z. B.
                für optionale Cookies).
              </p>
            </LegalSection>

            <LegalSection id="speicherdauer" title="4. Speicherdauer">
              <p>
                Konto-Daten werden gespeichert, solange dein Konto besteht. Run-Logs werden standardmäßig
                90 Tage aufbewahrt, damit du deine Historie einsehen kannst. Du kannst jederzeit einzelne Runs
                löschen oder dein Konto vollständig entfernen.
              </p>
            </LegalSection>

            <LegalSection id="dritte" title="5. Drittanbieter und Auftragsverarbeiter">
              <p>Zum Betrieb von Floom nutzen wir:</p>
              <ul>
                <li>Hetzner Online GmbH (Deutschland): Hosting von Floom-Backend und Datenbank.</li>
                <li>OpenAI (USA) und Google (Gemini, USA / EU): LLM-Aufrufe, wenn eine Floom-App Parser- oder Generierungs-Funktionen nutzt. Eingaben werden an den Modellanbieter übertragen.</li>
                <li>Better Auth: Authentifizierungs-Infrastruktur (self-hosted auf unserer Infrastruktur).</li>
                <li>Stripe (geplant, USA / Irland): Zahlungsabwicklung für kostenpflichtige Pläne.</li>
                <li>GitHub (geplant, USA): OAuth-Login über GitHub, falls du dich dafür entscheidest.</li>
              </ul>
              <p>
                Bei Übermittlungen in Drittländer stützen wir uns auf Standardvertragsklauseln und geeignete
                technische und organisatorische Maßnahmen. Mit Auftragsverarbeitern schließen wir AV-Verträge
                nach Art. 28 DSGVO.
              </p>
            </LegalSection>

            <LegalSection id="rechte" title="6. Deine Rechte">
              <p>Du hast das Recht auf:</p>
              <ul>
                <li>Auskunft über die zu deiner Person gespeicherten Daten (Art. 15 DSGVO).</li>
                <li>Berichtigung unrichtiger Daten (Art. 16 DSGVO).</li>
                <li>Löschung, sofern keine gesetzlichen Aufbewahrungspflichten entgegenstehen (Art. 17 DSGVO).</li>
                <li>Einschränkung der Verarbeitung (Art. 18 DSGVO).</li>
                <li>Datenübertragbarkeit (Art. 20 DSGVO).</li>
                <li>Widerspruch gegen Verarbeitung auf Grundlage berechtigter Interessen (Art. 21 DSGVO).</li>
                <li>Beschwerde bei einer Aufsichtsbehörde, etwa dem Hamburgischen Beauftragten für Datenschutz und Informationsfreiheit.</li>
              </ul>
              <p>
                Für alle Anfragen wende dich bitte an{' '}
                <a href="mailto:depontefede@gmail.com">depontefede@gmail.com</a>.
              </p>
            </LegalSection>

            <LegalSection id="cookies" title="7. Cookies">
              <p>
                Floom verwendet nur technisch notwendige Cookies (z. B. Session-Cookie für Better Auth und eine
                Präferenz-Cookie für deine Cookie-Entscheidung). Details findest du in der{' '}
                <a href="/cookies">Cookie-Richtlinie</a>.
              </p>
            </LegalSection>

            <LegalSection id="aenderungen" title="8. Änderungen dieser Erklärung">
              <p>
                Diese Datenschutzerklärung kann angepasst werden, etwa bei neuen Features oder neuen
                Drittanbietern. Die jeweils aktuelle Version ist unter dieser URL abrufbar; das Datum oben
                zeigt den letzten Stand.
              </p>
            </LegalSection>
          </>
        ) : (
          <>
            <LegalSection id="controller" title="1. Controller">
              <p>
                Controller under the General Data Protection Regulation (GDPR):
                <br />
                Federico De Ponte, Mansteinstraße 27, 20253 Hamburg, Germany
                <br />
                Email: <a href="mailto:depontefede@gmail.com">depontefede@gmail.com</a>
              </p>
            </LegalSection>

            <LegalSection id="data" title="2. What data we collect">
              <p>Operating Floom involves processing the following categories of personal data:</p>
              <ul>
                <li>Account data: email address and password hash (for Better Auth authentication).</li>
                <li>Usage data: app run history (run logs, inputs, outputs), API keys you add to your account.</li>
                <li>Technical data: IP address (for rate limiting and abuse prevention), user agent, timestamps.</li>
                <li>Payment data (future): handled by Stripe for paid plans. Stripe acts as an independent controller for payment data.</li>
              </ul>
            </LegalSection>

            <LegalSection id="basis" title="3. Legal basis">
              <p>
                We process personal data on the basis of Art. 6 (1) (b) GDPR (performance of the user
                agreement), Art. 6 (1) (f) GDPR (legitimate interest in secure operation and abuse
                prevention), and, where required, Art. 6 (1) (a) GDPR (consent, for example for optional
                cookies).
              </p>
            </LegalSection>

            <LegalSection id="retention" title="4. Retention">
              <p>
                Account data is retained as long as your account exists. Run logs are kept for 90 days by
                default so you can review your history. You can delete individual runs or your entire account
                at any time.
              </p>
            </LegalSection>

            <LegalSection id="third-parties" title="5. Third parties and processors">
              <p>To operate Floom we use:</p>
              <ul>
                <li>Hetzner Online GmbH (Germany): hosting for the Floom backend and database.</li>
                <li>OpenAI (USA) and Google (Gemini, USA / EU): LLM calls when a Floom app uses parser or generation features. Inputs are transmitted to the model provider.</li>
                <li>Better Auth: authentication infrastructure (self-hosted on our infrastructure).</li>
                <li>Stripe (planned, USA / Ireland): payment processing for paid plans.</li>
                <li>GitHub (planned, USA): OAuth login via GitHub if you choose this option.</li>
              </ul>
              <p>
                For transfers to third countries we rely on Standard Contractual Clauses and appropriate
                technical and organizational measures. We conclude data processing agreements (Art. 28 GDPR)
                with our processors.
              </p>
            </LegalSection>

            <LegalSection id="rights" title="6. Your rights">
              <p>You have the right to:</p>
              <ul>
                <li>Access the personal data we hold about you (Art. 15 GDPR).</li>
                <li>Rectify inaccurate data (Art. 16 GDPR).</li>
                <li>Erasure, unless statutory retention obligations apply (Art. 17 GDPR).</li>
                <li>Restrict processing (Art. 18 GDPR).</li>
                <li>Data portability (Art. 20 GDPR).</li>
                <li>Object to processing based on legitimate interests (Art. 21 GDPR).</li>
                <li>Lodge a complaint with a supervisory authority, for example the Hamburg Commissioner for Data Protection and Freedom of Information.</li>
              </ul>
              <p>
                For any request, please contact{' '}
                <a href="mailto:depontefede@gmail.com">depontefede@gmail.com</a>.
              </p>
            </LegalSection>

            <LegalSection id="cookies" title="7. Cookies">
              <p>
                Floom only uses strictly necessary cookies (such as a Better Auth session cookie and a
                preference cookie for your cookie choice). See our <a href="/cookies">cookie policy</a> for
                details.
              </p>
            </LegalSection>

            <LegalSection id="changes" title="8. Changes to this policy">
              <p>
                This policy may be updated, for example when new features or new third parties are
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
