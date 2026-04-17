// /imprint - Impressum (required by §5 TMG for DE commercial sites).
// Bilingual DE + EN stub. Lang toggle at top. Preliminary draft notice.
// Will be replaced by lawyer-reviewed version before paid launch.

import { useState } from 'react';
import { PageShell } from '../components/PageShell';
import { LegalLangToggle, LegalPageHeader, LegalSection, type Lang } from '../components/LegalPageChrome';

export function ImprintPage() {
  const [lang, setLang] = useState<Lang>('de');

  return (
    <PageShell title="Imprint / Impressum · Floom">
      <article style={{ maxWidth: 720, margin: '0 auto' }}>
        <LegalLangToggle lang={lang} onChange={setLang} />
        <LegalPageHeader
          title={lang === 'de' ? 'Impressum' : 'Imprint'}
          updated="2026-04-17"
          lang={lang}
        />

        {lang === 'de' ? (
          <>
            <LegalSection id="tmg" title="Angaben gemäß § 5 TMG">
              <p>
                Federico De Ponte
                <br />
                Einzelunternehmer
                <br />
                Mansteinstraße 27
                <br />
                20253 Hamburg
                <br />
                Deutschland
              </p>
            </LegalSection>

            <LegalSection id="kontakt" title="Kontakt">
              <p>
                E-Mail:{' '}
                <a href="mailto:team@floom.dev">team@floom.dev</a>
                <br />
                Telefon: +49 151 67609512
              </p>
            </LegalSection>

            <LegalSection id="umsatzsteuer" title="Umsatzsteuer">
              <p>
                Floom wird derzeit als Einzelunternehmen betrieben. Eine Umsatzsteuer-Identifikationsnummer
                ist nicht vorhanden; es gilt voraussichtlich die Kleinunternehmerregelung nach § 19 UStG.
                Sollte Floom später in eine juristische Person (GmbH / UG) überführt werden, wird dieses
                Impressum entsprechend aktualisiert.
              </p>
            </LegalSection>

            <LegalSection id="verantwortlich" title="Verantwortlich für den Inhalt nach § 18 Abs. 2 MStV">
              <p>
                Federico De Ponte
                <br />
                Mansteinstraße 27, 20253 Hamburg
              </p>
            </LegalSection>

            <LegalSection id="streitschlichtung" title="EU-Streitschlichtung">
              <p>
                Die Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung (OS) bereit:{' '}
                <a href="https://ec.europa.eu/consumers/odr/" target="_blank" rel="noreferrer">
                  https://ec.europa.eu/consumers/odr/
                </a>
                . Unsere E-Mail-Adresse finden Sie oben im Impressum. Wir sind nicht bereit oder verpflichtet,
                an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.
              </p>
            </LegalSection>

            <LegalSection id="haftung" title="Haftung für Inhalte">
              <p>
                Als Diensteanbieter sind wir gemäß § 7 Abs. 1 TMG für eigene Inhalte auf diesen Seiten nach
                den allgemeinen Gesetzen verantwortlich. Nach §§ 8 bis 10 TMG sind wir als Diensteanbieter
                jedoch nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu überwachen
                oder nach Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen.
              </p>
              <p>
                Floom hostet benutzergenerierte Anwendungen (z. B. über OpenAPI-Specs eingespielte Tools).
                Verpflichtungen zur Entfernung oder Sperrung der Nutzung von Informationen nach den
                allgemeinen Gesetzen bleiben hiervon unberührt. Eine diesbezügliche Haftung ist jedoch erst
                ab dem Zeitpunkt der Kenntnis einer konkreten Rechtsverletzung möglich. Bei Bekanntwerden
                entsprechender Rechtsverletzungen werden wir diese Inhalte umgehend entfernen.
              </p>
            </LegalSection>

            <LegalSection id="links" title="Haftung für Links">
              <p>
                Unser Angebot enthält Links zu externen Websites Dritter, auf deren Inhalte wir keinen
                Einfluss haben. Deshalb können wir für diese fremden Inhalte auch keine Gewähr übernehmen.
                Für die Inhalte der verlinkten Seiten ist stets der jeweilige Anbieter oder Betreiber der
                Seiten verantwortlich.
              </p>
            </LegalSection>

            <LegalSection id="urheberrecht" title="Urheberrecht">
              <p>
                Die durch die Seitenbetreiber erstellten Inhalte und Werke auf diesen Seiten unterliegen
                dem deutschen Urheberrecht. Beiträge Dritter sind als solche gekennzeichnet. Open-Source-Code
                von Floom selbst ist unter der jeweils im Repository angegebenen Lizenz verfügbar.
              </p>
            </LegalSection>
          </>
        ) : (
          <>
            <LegalSection id="tmg" title="Information pursuant to § 5 TMG">
              <p>
                Federico De Ponte
                <br />
                Sole trader (Einzelunternehmer)
                <br />
                Mansteinstraße 27
                <br />
                20253 Hamburg
                <br />
                Germany
              </p>
            </LegalSection>

            <LegalSection id="contact" title="Contact">
              <p>
                Email:{' '}
                <a href="mailto:team@floom.dev">team@floom.dev</a>
                <br />
                Phone: +49 151 67609512
              </p>
            </LegalSection>

            <LegalSection id="vat" title="VAT">
              <p>
                Floom is currently operated as a sole proprietorship. No VAT identification number has been
                issued; the small-business exemption under § 19 UStG is expected to apply. If Floom is later
                converted into a legal entity (GmbH / UG), this imprint will be updated accordingly.
              </p>
            </LegalSection>

            <LegalSection id="responsible" title="Responsible for content under § 18 (2) MStV">
              <p>
                Federico De Ponte
                <br />
                Mansteinstraße 27, 20253 Hamburg, Germany
              </p>
            </LegalSection>

            <LegalSection id="dispute" title="EU dispute resolution">
              <p>
                The European Commission provides an online dispute resolution (ODR) platform:{' '}
                <a href="https://ec.europa.eu/consumers/odr/" target="_blank" rel="noreferrer">
                  https://ec.europa.eu/consumers/odr/
                </a>
                . Our email address is listed above. We are neither willing nor obliged to participate in
                dispute resolution proceedings before a consumer arbitration board.
              </p>
            </LegalSection>

            <LegalSection id="liability" title="Liability for content">
              <p>
                As a service provider, we are responsible for our own content on these pages in accordance
                with § 7 (1) TMG under the general laws. According to §§ 8 to 10 TMG, however, we are not
                obliged to monitor transmitted or stored third-party information or to investigate
                circumstances that indicate illegal activity.
              </p>
              <p>
                Floom hosts user-generated applications (for example tools imported via OpenAPI specs).
                Obligations to remove or block the use of information under general laws remain unaffected.
                Liability in this regard is only possible from the point in time at which a concrete legal
                violation becomes known. On notification of corresponding legal violations, we will remove
                the affected content immediately.
              </p>
            </LegalSection>

            <LegalSection id="links" title="Liability for links">
              <p>
                Our site contains links to external websites of third parties over whose content we have no
                influence. We therefore cannot accept any liability for this external content. The
                respective provider or operator of the linked pages is always responsible for their content.
              </p>
            </LegalSection>

            <LegalSection id="copyright" title="Copyright">
              <p>
                Content and works created by the site operators on these pages are subject to German
                copyright law. Contributions by third parties are marked as such. Open-source code authored
                by Floom itself is available under the license stated in the respective repository.
              </p>
            </LegalSection>
          </>
        )}
      </article>
    </PageShell>
  );
}
