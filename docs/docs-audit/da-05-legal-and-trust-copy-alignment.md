# da-05 — Legal and trust copy alignment

**Scope:** legal routes (`/legal`, `/imprint`, `/privacy`, `/terms`, `/cookies`, `/impressum`), `CookieBanner`, `SECURITY.md`, footer trust links, and every date / jurisdiction / contact / retention number in the trust surface — vs what [`docs/PRODUCT.md`](../PRODUCT.md) and [`docs/ROADMAP.md`](../ROADMAP.md) promise and what the code actually enforces.
**Audit run:** 2026-04-20, against `origin/main` `d62a4cf`. This is a **docs-audit** pass, not a legal review. Where there is existing coverage, we lean on [`pd-13-legal-cookie-trust-bar.md`](../product-audit/deep/pd-13-legal-cookie-trust-bar.md) rather than re-litigate product/UX issues.

## Executive summary

The legal pages exist, are routed, are bilingual (DE/EN) where EU reachability matters, and carry sensible dates (`updated="2026-04-20"` on every page). That is a strong P0 check. Where the pack drifts is the **cookie inventory** and the **retention/infra claims**:

1. **The user-facing cookie table omits the one cookie every user actually receives.** `apps/web/src/services/session.ts:26` sets `floom_device` on every request. `apps/web/src/pages/CookiesPage.tsx:18–46` lists `floom.session`, `floom.cookie-consent`, `floom.theme`. `floom.session` does not exist as written (Better Auth uses `__Secure-floom.session_token`, per `scripts/verify-hub-apps.mjs:30`); `floom_device` is not listed. Two of the four cookies a real user carries are mis-described.
2. **Privacy doc says run-log retention is 90 days** (`apps/web/src/pages/PrivacyPage.tsx:64–67, 163–168`). There is no retention sweeper in `apps/server` that deletes 90-day-old runs — verified by grep (no scheduled job, no cron, no retention helper). The claim is aspirational, not operational.
3. **Privacy doc says infrastructure is "in the EU"** (`apps/web/src/pages/PrivacyPage.tsx:73, 173–174`) while the same page says the controller is Floom, Inc. at a Delaware address (`:33–38`) and transfers to the US rely on SCCs. Not contradictory on paper — EU hosting with a US controller is legal — but the repo carries no evidence of EU hosting configuration. `docs/SELF_HOST.md` and `docker/.env.example` assume any region; the production infra shape is a GTM claim that a reader has no repo-side way to verify.
4. **`TermsPage.tsx:20` and `ImprintPage.tsx:18–27` use a Delaware address**; **`README.md:158` says "Built in SF".** Not a lie, but the three location stories (SF / Delaware / EU) arrive within ten minutes of reading (da-02 F8).
5. **`SECURITY.md:33` advertises the Docker image `ghcr.io/floomhq/floom-monorepo`** — matches CI. Adjacent rollback runbook (`docs/ROLLBACK.md`) still uses the legacy `ghcr.io/floomhq/floom` name on nine lines. A security researcher pointed at two different images in two canonical docs.
6. **Cookie banner says "essential cookies for sign-in and preferences"** (`apps/web/src/components/CookieBanner.tsx:158–163`). Behavior: there is no optional category (per `pd-13` R3). "Accept all" sets no additional cookies beyond what "Essential only" already sets. Copy and behavior are aligned **within the banner**, but the binary offered to the user is a non-choice. Not a doc-audit bug — flagged because the legal copy ("you can withdraw consent") assumes the user made a choice worth withdrawing.

The structural story is the cookie surface is *disclosed-about* in three places (`CookiesPage`, `PrivacyPage`, `CookieBanner`) and *implemented* in two (`session.ts`, Better Auth), and the three disclosures do not agree with each other, let alone with the two implementations.

---

## Executive truth table

| # | Doc claim (quote + path) | Code/Reality (`file:line`) | Verdict |
|---|--------------------------|----------------------------|---------|
| 1 | `CookiesPage.tsx:18–46` lists three cookies: `floom.session`, `floom.cookie-consent`, `floom.theme` | Server sets `floom_device` on every request (`apps/server/src/services/session.ts:26, 68–74`). Better Auth cookie is `__Secure-floom.session_token` in prod (`scripts/verify-hub-apps.mjs:30`), not `floom.session`. Two of the four real cookies are missing or mis-named. | **Contradicted** |
| 2 | `PrivacyPage.tsx:47, 148`: "a device-ID cookie for anonymous sessions" | Real cookie name is `floom_device`; TTL `315_360_000 seconds` = 10 years (`apps/server/src/services/session.ts:26–28`). Same `PrivacyPage.tsx:64–66, 163–168` says "Session cookies expire after 30 days at the latest" — does not cover the 10-year device cookie. | **Partial** — mentioned, not correctly characterized |
| 3 | `PrivacyPage.tsx:64–67, 163–168`: "Run logs are kept for 90 days by default" | `apps/server/src/db.ts`, `apps/server/src/services/runs.ts`, and every scheduled job under `apps/server/src/services/` — no 90-day sweeper found. `runs` table rows persist indefinitely. | **Missing** (enforcement) |
| 4 | `PrivacyPage.tsx:73, 174`: "Infrastructure and hosting providers for servers and database in the EU" | No EU-region pin in `docker/`, `Dockerfile`, `apps/server/`, or docs. `docs/SELF_HOST.md` is region-agnostic. Production hosting is a cloud-ops claim with no repo evidence. | **Unverifiable in repo** |
| 5 | `PrivacyPage.tsx:86–91, 188–195`: transfers to US via SCCs | Consistent with Floom, Inc. being a US entity. Whether SCCs are actually executed is a legal-ops claim, not a code claim. | **Consistent — unverifiable in repo** |
| 6 | `ImprintPage.tsx:19–27`: `1207 Delaware Ave, Suite 226, Wilmington, DE 19806` | Same address in `PrivacyPage.tsx:34–36, 135–137` and `TermsPage.tsx:21`. Consistent across three pages. | **Met** |
| 7 | `README.md:158`: "Built in SF by @federicodeponte" | Delaware C-Corp (ImprintPage). Not contradictory (company incorporation ≠ founder location), but three location stories (SF / DE / EU) in ten minutes of reading. | **Drift** — minor trust friction |
| 8 | `ImprintPage.tsx:1–6` comment: "Floom is a Delaware C-Corp (Floom, Inc., filed via Every.io 2026-04-17). US entities don't use a German 'Impressum / §5 TMG' frame." | `/impressum` route exists as an alias (`apps/web/src/main.tsx:258`) pointing at `/legal`. Route-level back-compat ✅. But a German user visiting `/impressum` expecting §5 TMG content finds a short "who we are" card (`ImprintPage.tsx:11–47`) that does not self-describe as compliant with §5 TMG. Doc-code match; legal-expectation drift. | **Partial** (legal Q) |
| 9 | `TermsPage.tsx:20, 118–127`: Delaware governing law, Delaware courts, exclusive jurisdiction | `PrivacyPage.tsx:30–38, 129–141` identifies Floom, Inc. as controller in Delaware. `PrivacyPage.tsx:103` also gives EU residents the right to lodge complaints with an EU DPA. Consistent: DE law governs terms; GDPR rights remain available to EU subjects. | **Met** |
| 10 | `TermsPage.tsx:92`: "$100" alternative liability cap | Consistent with standard pre-revenue SaaS Terms. No repo code that enforces or contradicts. | **N/A** (code-agnostic legal) |
| 11 | `CookieBanner.tsx:158–163`: "Floom uses essential cookies for sign-in and preferences." | Matches `CookiesPage.tsx:118–122, 154–157` ("we only set strictly necessary and preference cookies"). **But** `CookieBanner.tsx:183–199` offers an "Accept all" button that, in the current implementation, adds zero cookies beyond what "Essential only" already sets (no optional category wired). | **Partial** — copy honest, UX misleading |
| 12 | `CookiesPage.tsx:126–134, 162–168`: "You can withdraw consent by reopening the banner" | `CookieBanner.tsx:77–79` only renders when `readChoice() === null`. Once a choice is stored there is **no UX path to reopen the banner** — the user must clear localStorage + the `floom.cookie-consent` cookie manually. | **Contradicted** — `pd-13` R2 |
| 13 | `SECURITY.md:24`: Supported image `ghcr.io/floomhq/floom-monorepo` | Matches CI (`.github/workflows/publish-image.yml:37–46`). `docs/ROLLBACK.md` still references the legacy `ghcr.io/floomhq/floom:*` nine times (da-01 F10). A researcher cross-referencing the two docs sees two image names. | **Drift** — SECURITY.md correct, adjacent runbook wrong |
| 14 | `SECURITY.md:16–18`: "Acknowledgement within 2 business days. Initial assessment and severity within 7 days. A fix, mitigation, or timeline within 30 days for high-severity issues." | No SLA tracker / CODEOWNERS auto-assignment in `.github/`. Promise is operational, not structurally enforced in repo. | **Consistent — operational, not enforceable via code** |
| 15 | `SECURITY.md:38`: "User-uploaded custom renderers running in sandbox (report sandbox-escape issues only)" | Renderer sandbox is wired: `apps/server/src/routes/renderer.ts`, iframe `sandbox="allow-scripts"` per `spec/protocol.md:342`, details in `docs/SELF_HOST.md:639–662`. | **Met** |
| 16 | `CookiesPage.tsx` — **no dated version history, no "preliminary draft" banner on this page** | `LegalPageHeader` component at `LegalPageHeader.tsx` renders a "preliminary draft" banner per `pd-13:37`. It's applied to Privacy/Terms/Legal/Cookies — verified via `CookiesPage.tsx:102–106` which uses `LegalPageHeader`. | **Met** |
| 17 | `PrivacyPage.tsx:5–7` comment: "Bilingual DE + EN" default | `CookiesPage.tsx:96` defaults `lang='de'` while `PrivacyPage.tsx:14` defaults `lang='en'`. Same product, two different default languages. `pd-13:22` flagged this. | **Drift** — cosmetic; noted for consistency |
| 18 | `docs/PRODUCT.md:17` frames ICP as "a non-developer AI engineer … Not an infra pro, not a DevRel hire" | Legal pages assume a reader who knows what "Art. 6 (1) (b) GDPR" refers to (`PrivacyPage.tsx:55, 156–161`). Not wrong (standard legal copy), but a reader calibration mismatch. Irrelevant to doc-accuracy; noted for completeness. | **N/A** |

---

## Concrete findings

### F1 — Cookie inventory drift (three disclosures, zero agreement)

Three user-facing places describe which cookies Floom sets:

- **Privacy page** (`apps/web/src/pages/PrivacyPage.tsx:47, 148`): "device-ID cookie for anonymous sessions". No name given. No TTL given.
- **Cookie policy** (`apps/web/src/pages/CookiesPage.tsx:18–46`): three cookies — `floom.session`, `floom.cookie-consent`, `floom.theme`.
- **Cookie banner** (`apps/web/src/components/CookieBanner.tsx:158–163`): "essential cookies for sign-in and preferences". No names.

Two places set cookies in code:

- **Device cookie** (`apps/server/src/services/session.ts:26, 68–74`): name `floom_device`, `HttpOnly`, `SameSite=Lax`, `Max-Age=315_360_000` (10 years). Set on every request regardless of auth state.
- **Better Auth session cookie** (used by `apps/server/src/lib/better-auth.ts` and referenced by `scripts/verify-hub-apps.mjs:30`): `__Secure-floom.session_token` in prod, `floom.session_token` in dev. Not `floom.session`.
- **Cookie consent cookie** (`CookieBanner.tsx:20, 53`): name `floom.cookie-consent`. Matches the policy ✅.
- **Theme cookie**: `pd-13` R14 flags that the actual theme persistence mechanism (localStorage vs cookie) is not audited. If `floom.theme` is localStorage-only, it does not belong in the cookie table at all.

**Net:** the cookie policy lists a cookie that does not exist (`floom.session`), the cookie policy does **not** list a cookie that exists on every request (`floom_device`), and `pd-13:42–43` flagged this already. No remediation since.

### F2 — Retention claim has no enforcer

`PrivacyPage.tsx:64, 164`: *"Run logs are kept for 90 days by default. Session cookies expire after 30 days at the latest."*

- **Session cookies**: partially true. The Better Auth session cookie has a default 30-day TTL (Better Auth docs). The `floom_device` cookie has a **10-year** TTL (`session.ts:28`). Doc writes "session cookies"; the implementation ships one session cookie and one long-lived device cookie. A pedantic reader can parse "session cookie" as excluding the device cookie; a casual reader cannot.
- **Run logs 90 days**: no enforcer found. Grep across `apps/server/src/services/` and `apps/server/src/routes/` for patterns like `90.*days`, `retention`, `deleteOlderThan`, `sweepRuns`, `cron.*runs` — no scheduled retention job. `apps/server/src/db.ts` creates the `runs` table without a TTL column, without a trigger, without a scheduled purge. **The 90-day retention promise is aspirational.** If a user requests under Art. 17 GDPR "delete my run logs older than 90 days" the implementation does not self-enforce that — they would need the account-deletion path (`PrivacyPage.tsx:106–109, 209–211`).

Not legal advice; a docs-audit factual observation. The privacy doc is writing a promise the code does not keep.

### F3 — Infrastructure location claim is unverifiable from the repo

`PrivacyPage.tsx:73, 174`: *"Infrastructure and hosting providers for servers and database in the EU."*

- `docker/.env.example` has no region pin.
- `Dockerfile` and the CI workflows do not mention any EU-specific infra.
- `docs/SELF_HOST.md` is region-agnostic.
- The claim is about the **hosted floom.dev** service, which is a cloud-ops reality the repo does not encode.

For a self-host operator, the claim is actively misleading — they set up wherever they want, and the user-facing privacy page they inherit says "EU". For a floom.dev user, the claim is an unverifiable marketing statement.

Docs-audit recommendation: qualify the claim as "floom.dev hosted on EU infrastructure (self-hosters configure their own region)". Legal decision, not doc-audit decision. Flagged.

### F4 — Three location stories in 10 minutes of reading

Covered in da-02 F8. Re-listed here for the legal-surface view:

- `README.md:158`: Built in SF.
- `ImprintPage.tsx:19–27`: Delaware C-Corp, Delaware business address.
- `PrivacyPage.tsx:73, 174`: EU infrastructure.
- `TermsPage.tsx:118–127`: Delaware governing law + courts.

None contradict each other structurally. All four can be simultaneously true. But the reader has to reconcile SF (founder, marketing) → Delaware (legal entity + jurisdiction) → EU (infrastructure) without any doc surface explaining the hierarchy. Trust-surface coherence recommendation: `ImprintPage.tsx` or `PrivacyPage.tsx` carries a one-line "Why the three addresses?" explainer.

### F5 — Cookie banner "Accept all" is a non-choice

`CookieBanner.tsx:183–199` renders an `Accept all` button. `CookieBanner.tsx:83–86` writes `floom.cookie-consent=all` (vs `=essential`) to localStorage and the cookie. No other cookie is set, no script is unblocked, no tracker is enabled by the user choosing `all` vs `essential`. It is a preference with no effect.

Matching doc copy:

- `CookiesPage.tsx:118–122, 154–157`: "We only set strictly necessary and preference cookies. We currently do not embed any analytics, tracking, or advertising cookies."
- Cookie banner copy: "essential cookies for sign-in and preferences."

So the **copy is honest**. The **UX element** (the `Accept all` button) is a leftover from a world where Floom did have optional categories. Not a doc bug; a UX bug that makes the doc copy look like a dark-pattern adjacent because offering "Accept all" when there is no all-vs-essential difference looks like a CMP theater.

Fix candidates (product decision): (a) remove the `Accept all` button, (b) actually wire an optional analytics category when `VITE_SENTRY_DSN` is set in an EU-facing deployment (and consent-gate the Sentry init — `pd-13` R4), (c) rename `Accept all` to just `OK` per `pd-13:3`. Out of scope for this doc-audit file; surfaced because the banner + policy + code form a three-way drift.

### F6 — Consent withdrawal path is documented and unimplemented

`CookiesPage.tsx:126, 162`: *"You can withdraw consent at any time by reopening the banner or clearing cookies in your browser."*

`CookieBanner.tsx:77–81`:

```
useEffect(() => {
  if (readChoice() === null) setVisible(true);
}, []);
if (!visible) return null;
```

The banner renders only when `readChoice() === null`. Once the user clicks either button, `writeChoice(choice)` persists the value, the banner hides, and there is **no `reopen` action exported or wired to the footer**. There is no footer link labeled "Cookie preferences". Grep of `apps/web/src/components/public/PublicFooter.tsx` (and the `Footer.tsx` re-export pattern cited in `pd-13:106`) does not find a cookie-settings link.

To actually withdraw consent, the user must follow the policy's fallback instruction: manually delete the `floom.cookie-consent` cookie and localStorage key in browser devtools. That is a skilled-user action; the policy advertises it as a user-exposed control.

Already flagged in `pd-13` R2. Surfaced here because the **docs-audit framing** is: **the privacy/cookie docs promise a user control that the UI does not provide**. That's a doc-code contradiction, not a UX polish item.

### F7 — "Preliminary draft" banner helps; missing on one page

`LegalPageHeader` (per `pd-13:37`) renders a "preliminary draft" banner on Privacy, Terms, Legal, Cookies. All four pages call `LegalPageHeader` (verified in `CookiesPage.tsx:102, PrivacyPage.tsx:20, TermsPage.tsx:14, ImprintPage.tsx:15`). Consistent. ✅

Secondary angle: none of the four pages carries a `version="0.1"` or history. The `updated="2026-04-20"` field is a date stamp only. If the content changes tomorrow, the only thing updating is the date — there is no way for an inquisitive user to diff. For a pre-1.0 legal surface that openly admits being a preliminary draft this is defensible. Flag for future (`pd-13` PM Q6).

### F8 — SECURITY.md points at `floom-monorepo`, ROLLBACK points at `floom`

`SECURITY.md:33`: `Docker image ghcr.io/floomhq/floom-monorepo`

`docs/ROLLBACK.md:21, 22, 69, 83, 100, 101, 116, 125, 166`: `ghcr.io/floomhq/floom:<tag>`

A security researcher reporting an issue in "the image" has two canonical documents with two canonical names. SECURITY is correct; ROLLBACK is not (da-01 F10, da-04 F4). Same fix as everywhere else in the pack: rename ROLLBACK references to `floom-monorepo`.

### F9 — Footer discoverability is OK

`pd-13:48` confirms `PublicFooter` carries Legal / Privacy / Terms / Cookies / GitHub / Docs / About. All four legal routes are mounted (`apps/web/src/main.tsx:247–251`) with alias redirects (`:253–258`). A visitor landing on any page of the app can reach each policy in one click. The discoverability surface is the strongest part of the trust pack.

### F10 — `team@floom.dev` is the one contact across every surface

Contact inventory:

- `ImprintPage.tsx:33, 39–41`: `team@floom.dev`
- `PrivacyPage.tsx:38, 108, 139, 209`: `team@floom.dev`
- `TermsPage.tsx:151`: `team@floom.dev`
- `SECURITY.md:5`: `team@floom.dev`
- `README.md` footer: no email (@federicodeponte GitHub profile)

Consistent across legal surface. ✅. Unique one-address-for-everything simplicity. If that inbox is ever wound down or the team fragments, five docs need updating in lockstep.

### F11 — `updated="2026-04-20"` everywhere — good, but no gating

All four legal pages stamp `updated="2026-04-20"`. Bulk-update is a good sign someone reviewed all four. Bad sign: the stamp is a hard-coded string in the component call, not pulled from git metadata or a config file. A docs edit that forgets to bump the date ships silently. Low severity; flagged for repeatability.

### F12 — `PrivacyPage.tsx:49, 150`: "Payment data (future)"

The privacy doc hedges Stripe Connect as "future" (`:49`: "Zahlungsdaten (zukünftig)" / `:150`: "Payment data (future)"). The implementation ships it now (`apps/server/src/routes/stripe.ts`, six paths in `/openapi.json`, `docs/monetization.md`). Same drift as `docs/ROADMAP.md:28` (da-01 F6). The privacy doc under-promises, which is the safe direction to drift, but also a signal the legal copy is out of sync with code changes.

### F13 — Terms `scope` clause mentions `preview.floom.dev`

`TermsPage.tsx:18–22`: *"floom.dev and related services, including preview.floom.dev"*. `preview.floom.dev` is a cloud-deploy subdomain. No repo-side config of what "preview" means; an extra hostname customers can discover from the Terms but not the SPA top-level navigation. Harmless inclusion; noted because readers often over-parse these.

---

## Risk register

| ID | Sev | Risk | Evidence |
|----|-----|------|----------|
| da5-R1 | **P0** | Cookie table lists a cookie that does not exist (`floom.session`) and omits one that does (`floom_device`). Public disclosure is inaccurate. | `apps/web/src/pages/CookiesPage.tsx:18–46`; `apps/server/src/services/session.ts:26–74`; `scripts/verify-hub-apps.mjs:30` |
| da5-R2 | **P0** | Privacy doc promises 90-day run-log retention; no code enforces deletion. A data-subject Art. 17 request is a manual operation by the owner, not a configured sweeper. | `apps/web/src/pages/PrivacyPage.tsx:64, 164`; `apps/server/src/db.ts`, `apps/server/src/services/runs.ts` (no retention sweeper) |
| da5-R3 | **P1** | Cookie policy says users can "withdraw consent by reopening the banner"; banner has no reopen path. Documented user control does not exist. | `apps/web/src/pages/CookiesPage.tsx:126, 162`; `apps/web/src/components/CookieBanner.tsx:77–81` |
| da5-R4 | **P1** | Privacy claim "infrastructure in the EU" has no repo evidence. For self-hosters the claim is actively misleading in the template privacy doc. | `apps/web/src/pages/PrivacyPage.tsx:73, 174`; no region config in `docker/`, `Dockerfile`, `docs/SELF_HOST.md` |
| da5-R5 | **P1** | Banner offers `Accept all` as a distinct choice from `Essential only` while adding zero cookies for `all`. Looks like CMP theater, reinforces distrust. | `apps/web/src/components/CookieBanner.tsx:83–86, 183–199`; `apps/web/src/pages/CookiesPage.tsx:118–122` |
| da5-R6 | **P2** | SECURITY.md correctly points at `floom-monorepo`; adjacent ROLLBACK.md uses the legacy name nine times. Researchers see two canonical image names. | `SECURITY.md:24, 33`; `docs/ROLLBACK.md:21, 22, 69, 83, 100, 101, 116, 125, 166` |
| da5-R7 | **P2** | Three location stories (SF / Delaware / EU infra) in the first-30-minute funnel with no explainer. Low individual trust hit, repeated trust hit in aggregate. | `README.md:158`; `apps/web/src/pages/ImprintPage.tsx:19–27`; `apps/web/src/pages/PrivacyPage.tsx:73, 174` |
| da5-R8 | **P2** | Privacy doc's "payment data (future)" under-claims vs shipped Stripe Connect. Under-claims are safer but signal drift. | `apps/web/src/pages/PrivacyPage.tsx:49, 150`; `apps/server/src/routes/stripe.ts`; `docs/monetization.md` |
| da5-R9 | **P2** | Language defaults differ per page (`CookiesPage` DE, `PrivacyPage` EN). Cosmetic inconsistency. | `apps/web/src/pages/CookiesPage.tsx:96`; `apps/web/src/pages/PrivacyPage.tsx:14`; `pd-13:22` |
| da5-R10 | **P2** | `updated="2026-04-20"` is a hard-coded string in each component. Docs edits can ship without a date bump; no CI gate. | `ImprintPage.tsx:15`, `PrivacyPage.tsx:22`, `TermsPage.tsx:14`, `CookiesPage.tsx:104` |

---

## Open PM questions

1. **Fix the cookie table.** Two options: (a) update `CookiesPage.tsx:18–46` to include `floom_device` (10-year, HttpOnly, SameSite=Lax, purpose = anti-abuse session continuity) and rename `floom.session` → `__Secure-floom.session_token` (prod) / `floom.session_token` (dev). (b) Shorten the `floom_device` TTL so the "session" framing in privacy is defensible. **Decision required because it's a public disclosure.**
2. **Run-log retention.** Either (a) implement a nightly sweeper that deletes `runs` rows older than 90 days, or (b) rewrite `PrivacyPage.tsx:64, 164` to match reality ("kept until you delete your account"). Current text is unenforced.
3. **EU-hosting claim.** Either pin floom.dev's prod region publicly and add a repo-level config artifact (a `HOSTING.md`, a `.github` banner, a compose flag) or qualify the privacy doc to say "floom.dev currently hosts in region X; self-hosters configure their own region".
4. **Withdraw-consent UX.** Add a `Cookie preferences` link to `PublicFooter.tsx` that resets `floom.cookie-consent` and remounts the banner. Without this, the policy's withdrawal paragraph is a promise the UI does not keep.
5. **`Accept all` button semantics.** Either wire an optional analytics category (Sentry, product analytics) behind consent, or reduce the banner to a single `OK` button per `pd-13` PM Q2. Status quo is a choice without consequences.
6. **`ROLLBACK.md` → `floom-monorepo`.** Same PR that fixes da-01 F1 closes this. Docs-audit scope does not include the PR but flagging for the bundle.
7. **SF / Delaware / EU explainer.** One paragraph on `ImprintPage.tsx` clarifying why three geographies appear saves a trust-tax across every reader.
8. **Legal doc CI gate.** Consider a check that the `updated=` stamp is within N days of the last commit that touched the file. Low priority; repeatability aid.

---

## Source index

| Area | Paths |
|------|-------|
| Legal routes | `apps/web/src/main.tsx:247–258` |
| Imprint | `apps/web/src/pages/ImprintPage.tsx:1–47` |
| Privacy | `apps/web/src/pages/PrivacyPage.tsx:1–234` |
| Terms | `apps/web/src/pages/TermsPage.tsx:1–157` |
| Cookie policy | `apps/web/src/pages/CookiesPage.tsx:1–182` |
| Cookie banner | `apps/web/src/components/CookieBanner.tsx:1–225` |
| Device cookie | `apps/server/src/services/session.ts:26–74` |
| Better Auth cookie | `apps/server/src/lib/better-auth.ts`; `scripts/verify-hub-apps.mjs:30` |
| Security policy | `SECURITY.md:1–40` |
| Related product audit | `docs/product-audit/deep/pd-13-legal-cookie-trust-bar.md:1–116` |
| Rollback runbook image drift | `docs/ROLLBACK.md:21, 22, 69, 83, 100, 101, 116, 125, 166`; `.github/workflows/publish-image.yml:37–46` |
| Stripe vs privacy wording | `apps/web/src/pages/PrivacyPage.tsx:49, 150`; `apps/server/src/routes/stripe.ts`; `docs/monetization.md` |
