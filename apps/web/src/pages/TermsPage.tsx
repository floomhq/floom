// /terms — Terms of Service for Floom, Inc.
//
// Standard US SaaS boilerplate: Delaware governing law, Delaware courts for
// jurisdiction, AS-IS warranty disclaimer, 12-month damages cap. Pre-launch
// and free right now, but the boilerplate still applies.

import { PageShell } from '../components/PageShell';
import { LegalPageHeader, LegalSection } from '../components/LegalPageChrome';

export function TermsPage() {
  return (
    <PageShell title="Terms · Floom">
      <article style={{ maxWidth: 720, margin: '0 auto' }}>
        <LegalPageHeader title="Terms of Service" updated="2026-04-20" lang="en" />

        <LegalSection id="scope" title="1. Scope">
          <p>
            These Terms govern your use of the Floom platform (floom.dev and
            related services, including preview.floom.dev), operated by{' '}
            <strong>Floom, Inc.</strong>, a Delaware C-Corp with a business address
            at 1207 Delaware Ave, Suite 226, Wilmington, DE 19806, United States
            (&quot;Floom&quot;, &quot;we&quot;, &quot;us&quot;). By using Floom you agree to these Terms.
          </p>
        </LegalSection>

        <LegalSection id="account" title="2. Account">
          <p>
            Some features require an account. You agree to provide accurate
            information and keep your password confidential. Actions performed
            through the signed-in account are attributed to you.
          </p>
        </LegalSection>

        <LegalSection id="user-duties" title="3. Acceptable use">
          <p>When using Floom you agree not to:</p>
          <ul>
            <li>upload malware, exploits, or abusive code via OpenAPI specs, scripts, or container images;</li>
            <li>circumvent rate limits, authentication, or other technical controls;</li>
            <li>infringe any third-party rights, including copyright, trademark, or trade secrets;</li>
            <li>use Floom for unlawful, fraudulent, deceptive, or harmful purposes;</li>
            <li>process third-party personal data without a lawful basis or required consent;</li>
            <li>attempt to disrupt service, reverse engineer the platform, or extract user data in bulk.</li>
          </ul>
        </LegalSection>

        <LegalSection id="creator-duties" title="4. Creator content">
          <p>
            When you publish an app on Floom, you represent that you own or are
            licensed to use the underlying API, data, and branding, and that you
            have the right to offer the app through Floom. You agree to indemnify
            Floom against third-party claims arising from a breach of this
            representation, to the extent permitted by law.
          </p>
        </LegalSection>

        <LegalSection id="content" title="5. Your content">
          <p>
            Inputs, run outputs, BYOK keys, and other content added to the
            signed-in account remain your property. You grant Floom a worldwide,
            non-exclusive, royalty-free license to host, store, transmit, and
            process that content solely to operate the service on your behalf
            (including running, displaying, and caching it as needed to deliver
            the platform to you).
          </p>
        </LegalSection>

        <LegalSection id="availability" title="6. Availability">
          <p>
            Floom is under active development. We aim for high availability but
            do not guarantee a specific uptime. Maintenance windows, feature
            changes, and unplanned outages may occur. We may modify or
            discontinue features at any time.
          </p>
        </LegalSection>

        <LegalSection id="warranty" title="7. Warranty disclaimer">
          <p>
            FLOOM IS PROVIDED &quot;AS IS&quot; AND &quot;AS AVAILABLE&quot;, WITHOUT WARRANTIES OF
            ANY KIND, WHETHER EXPRESS, IMPLIED, OR STATUTORY, INCLUDING WITHOUT
            LIMITATION ANY IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
            PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT. We do not warrant
            that the service will be uninterrupted, error-free, or free of
            harmful components.
          </p>
        </LegalSection>

        <LegalSection id="liability" title="8. Limitation of liability">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, FLOOM&apos;S AGGREGATE LIABILITY
            ARISING OUT OF OR RELATING TO THESE TERMS OR THE SERVICE WILL NOT
            EXCEED THE GREATER OF (A) THE AMOUNTS YOU PAID TO FLOOM IN THE
            TWELVE (12) MONTHS PRECEDING THE EVENT GIVING RISE TO THE CLAIM, OR
            (B) US $100. FLOOM WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
            CONSEQUENTIAL, SPECIAL, OR EXEMPLARY DAMAGES, INCLUDING LOST PROFITS
            OR LOST DATA, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGES.
          </p>
        </LegalSection>

        <LegalSection id="suspension" title="9. Suspension and termination">
          <p>
            We may suspend or terminate the account with reasonable notice or,
            in case of serious violations (abuse of the platform, unlawful
            content, risk to other users), immediately. You may delete your
            account at any time from Account settings; deletion removes
            your data subject to standard retention windows described in the
            Privacy Policy.
          </p>
        </LegalSection>

        <LegalSection id="pricing" title="10. Pricing">
          <p>
            Use of the open-source components and the current preview is free.
            Paid tiers, when launched, will be subject to the prices shown at
            the time of order and billed via a third-party payment processor.
          </p>
        </LegalSection>

        <LegalSection id="law" title="11. Governing law and disputes">
          <p>
            These Terms are governed by the laws of the State of Delaware,
            United States, without regard to its conflict-of-laws rules. Any
            dispute arising out of or relating to these Terms or the service
            will be resolved exclusively in the state or federal courts located
            in the State of Delaware, and you consent to the personal
            jurisdiction of those courts. Mandatory consumer-protection rules
            in your country of habitual residence remain unaffected.
          </p>
        </LegalSection>

        <LegalSection id="changes" title="12. Changes">
          <p>
            We may update these Terms from time to time. Material changes will
            be posted on this page with an updated revision date and, where
            practical, communicated in-product. Your continued use after changes
            take effect constitutes acceptance.
          </p>
        </LegalSection>

        <LegalSection id="misc" title="13. Miscellaneous">
          <p>
            If any provision of these Terms is held unenforceable, the remaining
            provisions remain in effect. Our failure to enforce a right is not a
            waiver. These Terms, together with the Privacy Policy, are the
            entire agreement between you and Floom regarding the service.
          </p>
        </LegalSection>

        <LegalSection id="contact" title="14. Contact">
          <p>
            Questions about these Terms:{' '}
            <a href="mailto:team@floom.dev">team@floom.dev</a>.
          </p>
        </LegalSection>
      </article>
    </PageShell>
  );
}
