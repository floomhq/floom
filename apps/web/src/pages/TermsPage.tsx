// /terms - Terms of Service / AGB. Bilingual DE + EN stub. Governing law DE,
// jurisdiction Hamburg. Preliminary draft pending lawyer review.

import { useState } from 'react';
import { PageShell } from '../components/PageShell';
import { LegalLangToggle, LegalPageHeader, LegalSection, type Lang } from '../components/LegalPageChrome';

export function TermsPage() {
  const [lang, setLang] = useState<Lang>('de');

  return (
    <PageShell title="Terms · Floom">
      <article style={{ maxWidth: 720, margin: '0 auto' }}>
        <LegalLangToggle lang={lang} onChange={setLang} />
        <LegalPageHeader
          title={lang === 'de' ? 'Nutzungsbedingungen' : 'Terms of Service'}
          updated="2026-04-17"
          lang={lang}
        />

        {lang === 'de' ? (
          <>
            <LegalSection id="geltung" title="1. Geltungsbereich">
              <p>
                Diese Nutzungsbedingungen regeln die Nutzung der Plattform Floom (floom.dev,
                preview.floom.dev und verbundene Dienste), betrieben von Federico De Ponte, Mansteinstraße 27,
                20253 Hamburg. Mit der Nutzung von Floom akzeptierst du diese Bedingungen.
              </p>
            </LegalSection>

            <LegalSection id="konto" title="2. Konto">
              <p>
                Für die Nutzung bestimmter Funktionen ist ein Konto erforderlich. Du verpflichtest dich,
                wahrheitsgemäße Angaben zu machen und dein Passwort vertraulich zu behandeln. Handlungen, die
                über dein Konto erfolgen, werden dir zugerechnet.
              </p>
            </LegalSection>

            <LegalSection id="nutzerpflichten" title="3. Pflichten der Nutzer">
              <p>Bei der Nutzung von Floom verpflichtest du dich:</p>
              <ul>
                <li>keine schädlichen OpenAPI-Specs, Skripte oder Container-Images einzuspielen;</li>
                <li>die Rate-Limits und technischen Vorgaben der Plattform zu respektieren;</li>
                <li>keine Rechte Dritter zu verletzen, insbesondere Urheber- und Markenrechte;</li>
                <li>Floom nicht für rechtswidrige, betrügerische oder schädliche Zwecke zu nutzen;</li>
                <li>keine personenbezogenen Daten Dritter ohne Rechtsgrundlage zu verarbeiten.</li>
              </ul>
            </LegalSection>

            <LegalSection id="creator" title="4. Pflichten der Creator">
              <p>
                Wenn du eine App auf Floom veröffentlichst, sicherst du zu, dass du Inhaber oder
                Lizenznehmer der zugrunde liegenden API bist und das Recht hast, sie über Floom anzubieten.
                Du stellst Floom von Ansprüchen Dritter frei, die aus einer Verletzung dieser Zusicherung
                resultieren, soweit dies gesetzlich zulässig ist.
              </p>
            </LegalSection>

            <LegalSection id="inhalte" title="5. Inhalte, Runs und API-Schlüssel">
              <p>
                Eingaben, Run-Ergebnisse und API-Schlüssel, die du in dein Konto einträgst, bleiben dein
                geistiges Eigentum. Du gewährst uns eine einfache, zum Betrieb der Plattform notwendige
                Lizenz, diese Daten zu speichern, zu übertragen und bei Aufruf einer App zu verarbeiten.
              </p>
            </LegalSection>

            <LegalSection id="verfuegbarkeit" title="6. Verfügbarkeit">
              <p>
                Floom befindet sich in aktiver Entwicklung. Wir bemühen uns um eine hohe Verfügbarkeit,
                können aber keine bestimmte Uptime zusichern. Wartungsarbeiten und ungeplante Ausfälle sind
                möglich.
              </p>
            </LegalSection>

            <LegalSection id="gewaehrleistung" title="7. Haftung und Gewährleistung">
              <p>
                Floom wird „wie besehen" bereitgestellt. Für Schäden haften wir nur bei Vorsatz und grober
                Fahrlässigkeit sowie bei Verletzung wesentlicher Vertragspflichten (Kardinalpflichten);
                in diesem Fall ist die Haftung auf den vertragstypischen, vorhersehbaren Schaden begrenzt.
                Die Haftung nach dem Produkthaftungsgesetz sowie für Verletzungen von Leben, Körper und
                Gesundheit bleibt unberührt.
              </p>
            </LegalSection>

            <LegalSection id="sperrung" title="8. Sperrung und Kündigung">
              <p>
                Wir können Konten mit angemessener Frist oder, bei schwerwiegenden Verstößen, fristlos
                sperren oder löschen. Beispiele für schwerwiegende Verstöße sind Missbrauch der Plattform,
                rechtswidrige Inhalte oder Gefährdung anderer Nutzer.
              </p>
              <p>Du kannst dein Konto jederzeit ohne Angabe von Gründen löschen.</p>
            </LegalSection>

            <LegalSection id="preise" title="9. Preise und Zahlungen">
              <p>
                Die Nutzung der Open-Source-Komponenten und des kostenlosen Tarifs ist unentgeltlich. Für
                kostenpflichtige Tarife gelten die zum Zeitpunkt der Bestellung ausgewiesenen Preise; die
                Abrechnung erfolgt über einen externen Zahlungsdienstleister. Bis zum Start kostenpflichtiger
                Funktionen gelten diese Bedingungen mit dem Zusatz „Free during preview".
              </p>
            </LegalSection>

            <LegalSection id="recht" title="10. Anwendbares Recht und Gerichtsstand">
              <p>
                Es gilt das Recht der Bundesrepublik Deutschland unter Ausschluss des UN-Kaufrechts.
                Ausschließlicher Gerichtsstand für Kaufleute ist Hamburg. Verbraucherrechtliche Schutzvorschriften
                im Land des gewöhnlichen Aufenthalts bleiben unberührt.
              </p>
            </LegalSection>

            <LegalSection id="schlussbestimmungen" title="11. Schlussbestimmungen">
              <p>
                Sollten einzelne Bestimmungen unwirksam sein, bleibt die Wirksamkeit der übrigen Bestimmungen
                unberührt. Änderungen dieser Nutzungsbedingungen werden rechtzeitig angekündigt; fortgesetzte
                Nutzung nach Inkrafttreten gilt als Zustimmung.
              </p>
            </LegalSection>
          </>
        ) : (
          <>
            <LegalSection id="scope" title="1. Scope">
              <p>
                These Terms govern your use of the Floom platform (floom.dev, preview.floom.dev, and
                related services), operated by Federico De Ponte, Mansteinstraße 27, 20253 Hamburg,
                Germany. By using Floom you agree to these Terms.
              </p>
            </LegalSection>

            <LegalSection id="account" title="2. Account">
              <p>
                Some features require an account. You agree to provide accurate information and keep your
                password confidential. Actions performed through your account are attributed to you.
              </p>
            </LegalSection>

            <LegalSection id="user-duties" title="3. User obligations">
              <p>When using Floom you agree to:</p>
              <ul>
                <li>not upload malicious OpenAPI specs, scripts, or container images;</li>
                <li>respect the platform's rate limits and technical requirements;</li>
                <li>not infringe any third-party rights, in particular copyright and trademark rights;</li>
                <li>not use Floom for unlawful, fraudulent, or harmful purposes;</li>
                <li>not process third-party personal data without a lawful basis.</li>
              </ul>
            </LegalSection>

            <LegalSection id="creator-duties" title="4. Creator obligations">
              <p>
                When you publish an app on Floom, you represent that you own or are licensed to use the
                underlying API and that you have the right to offer it through Floom. You indemnify Floom
                against third-party claims arising from a breach of this representation, to the extent
                permitted by law.
              </p>
            </LegalSection>

            <LegalSection id="content" title="5. Content, runs and API keys">
              <p>
                Inputs, run outputs, and API keys you add to your account remain your intellectual
                property. You grant us a non-exclusive license, limited to operating the platform, to
                store, transmit, and process that data when an app is invoked.
              </p>
            </LegalSection>

            <LegalSection id="availability" title="6. Availability">
              <p>
                Floom is under active development. We aim for high availability but do not guarantee a
                specific uptime. Maintenance windows and unplanned outages may occur.
              </p>
            </LegalSection>

            <LegalSection id="warranty" title="7. Warranty and liability">
              <p>
                Floom is provided "as is". We are liable only for intent and gross negligence, and for
                breach of material contractual obligations (cardinal duties); in the latter case liability
                is limited to the typical, foreseeable contractual damage. Liability under the German
                Product Liability Act and for injury to life, body, or health remains unaffected.
              </p>
            </LegalSection>

            <LegalSection id="suspension" title="8. Suspension and termination">
              <p>
                We may suspend or delete accounts with reasonable notice or, in case of serious violations,
                immediately. Examples of serious violations include platform abuse, unlawful content, or
                endangering other users.
              </p>
              <p>You may delete your account at any time, without stating reasons.</p>
            </LegalSection>

            <LegalSection id="pricing" title="9. Pricing and payments">
              <p>
                Use of the open-source components and the free tier is free of charge. Paid tiers are
                subject to the prices shown at the time of order; billing is handled by an external
                payment processor. Until paid features launch these Terms apply with the rider "Free
                during preview".
              </p>
            </LegalSection>

            <LegalSection id="law" title="10. Governing law and jurisdiction">
              <p>
                These Terms are governed by the laws of the Federal Republic of Germany, excluding the UN
                Convention on Contracts for the International Sale of Goods. For merchants, the exclusive
                place of jurisdiction is Hamburg. Mandatory consumer-protection rules in your country of
                habitual residence remain unaffected.
              </p>
            </LegalSection>

            <LegalSection id="misc" title="11. Miscellaneous">
              <p>
                If any provision is invalid, the remaining provisions stay in effect. Changes to these
                Terms are announced in advance; continued use after they take effect constitutes
                acceptance.
              </p>
            </LegalSection>
          </>
        )}
      </article>
    </PageShell>
  );
}
