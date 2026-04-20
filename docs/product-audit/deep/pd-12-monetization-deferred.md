# pd-12: Monetization and deferred value

**Audit type:** Deep product truth (promise vs shipped surface vs expectation management)  
**Sources of truth:** `docs/PRODUCT.md`, `docs/ROADMAP.md`  
**Primary surfaces reviewed:** `docs/ROADMAP.md` (Stripe rows), `apps/server/src/routes/stripe.ts`, `apps/server/src/services/stripe-connect.ts`, `apps/server/src/routes/deploy-waitlist.ts`, `apps/web/src/pages/StudioSettingsPage.tsx`, `apps/web/src/components/studio/StudioSidebar.tsx`, `apps/server/src/index.ts` (mount + OpenAPI blurb)  
**Note:** `apps/web/src/components/public/AppStripe.tsx` is a **store row / landing tile** component (visual “stripe”), not Stripe payments — out of scope for payment monetization except naming collision awareness.  
**Cross-reference:** `docs/product-audit/deep/INDEX.md` (pd-12), `test/stress/test-w33-stripe-*.mjs` (API stress coverage)  
**Snapshot note:** Roadmap snapshot date in `ROADMAP.md` is an anchor; code state is authoritative for “what exists today.”

---

## 1. Executive truth table

| Promise or claim (from `PRODUCT.md` / `ROADMAP.md` / UI) | Where it appears | Reality (product + code) | Status |
|--------------------------------------------------------|------------------|---------------------------|--------|
| **Stripe Connect monetization** is **backend stub**, UI deferred to **v1.1+** | `ROADMAP.md` “Shipped backend, UI pending” table | Server exposes a full **W3.3** `/api/stripe` tree: Connect onboard + status, payment intents, refunds, subscriptions, signature-verified webhook; service implements **direct charges**, **5% application fee** (env-overridable), **30-day application-fee refund** policy, DB-scoped rows by workspace + owner. Webhook **reducers** for money movement are mostly **ack + store payload** until “W4.x” metering (`payment_intent.succeeded` / `charge.refunded` / `invoice.paid` are no-ops beyond dedupe). | **Partial** — API + policy **shipped**; **business/product completion** and **all UI** still **Missing** relative to “monetization users can run end-to-end” |
| **Stripe Connect UI** in **P2 — Month one** | `ROADMAP.md` P2 | Studio shows **Billing** only as **stub**: settings page “Coming v1.1” card; sidebar **“Billing (soon)”** is non-clickable (`cursor: not-allowed`). No in-app flow to `/api/stripe/connect/onboard`. | **Missing** (creator-facing) |
| **Self-host free** vs **paid Cloud** value | `StudioSettingsPage.tsx` Billing stub copy | Copy: “Running Studio yourself is free forever. Paid Cloud adds longer-running jobs, live updates, and managed sign-in keys.” Aligns with self-host vs cloud split in product thinking. No pricing, no checkout, no link to sales. | **Partial** — expectation **named**; **commerce path** **Missing** |
| **Creators monetize end users** via Floom-facilitated Stripe (Connect partner model) | Implied by Connect service comments + `index.ts` OpenAPI description (“Stripe Connect”) | Backend can create connected accounts and charges **if** keys and Stripe dashboard are configured; **no Studio or public-page surfacing** for “sell runs / subscriptions.” | **Partial** (API-only) |
| **Deploy waitlist** as a **product-visible** monetization or launch lever | Not in `ROADMAP.md` table | `POST /api/deploy-waitlist` persists `email` + optional `spec_url` to SQLite (`deploy_waitlist`). **No** `apps/web` reference found — likely **headless / marketing / future `/build`** integration. | **Missing** (discoverable ICP path) unless wired outside this repo |
| **ICP** should not need payment-platform vocabulary to succeed | `PRODUCT.md` ICP | Billing stub avoids Stripe jargon and speaks to outcomes (jobs, updates, keys). Sidebar “Billing (soon)” is neutral. **OpenAPI** doc in `index.ts` mentions Stripe for integrators — appropriate for **HTTP client** audience, not first-run ICP. | **Met** for current **stub** copy; **risk** rises when Connect UI ships without plain-language split (**creator payouts** vs **Floom subscription**) |
| **Enterprise** procurement (contracts, RBAC, invoice-to-legal-entity) | `ROADMAP.md` P3 “Enterprise RBAC” | No enterprise billing, no Floom-side **usage invoices** in UI, no SSO in near roadmap (GitHub SSO “decide” in P2). Stripe Connect is **creator MoR**, not Floom B2B enterprise deal structure. | **Missing** — by design in pre-1.0; **misalignment risk** if outbound sells “enterprise-ready monetization” |

**Legend:** **Met** = aligned for the stated audience and path. **Partial** = true for a subset (e.g. API-only, policy without UI). **Missing** = not present where users expect it. **Contradicted** = two artifacts disagree (see row 1: “stub” vs rich backend — **wording** in roadmap understates code; **outcome** is still stubby without UI + reducers).

---

## 2. ICP journey — monetization and “deferred value” (with failure branches)

**Assumed ICP:** Non-developer AI engineer who self-serves on cloud Floom (`PRODUCT.md`).

| Step | What they see / do | Intended mental model | Failure branches |
|------|--------------------|------------------------|------------------|
| **1 — Discover Studio settings** | `/studio/settings` explains creator prefs; **Billing** is a dashed **Coming v1.1** card | “I can use Floom seriously before I pay; paid cloud is later.” | **A — v1.1 fatigue:** Multiple sections say “Coming v1.1” (API keys + billing); feels like **half a product** without a single **what ships when** link. **B — ‘Cloud plan’ undefined:** No price, no limits table — user cannot compare self-host vs cloud on **concrete** terms. |
| **2 — Sidebar curiosity** | Footer shows **Billing (soon)** — not a link | Same as above; “soon” manages urgency | **C — Dead-end:** Cannot even open a **mailto / waitlist / Cal.com** from Billing — zero capture for **intent to pay**. **D — Mismatch with roadmap:** P2 says month one for Connect UI; “v1.1” in copy may **contradict** roadmap cadence in the buyer’s head. |
| **3 — Assume they must monetize runs** | No guided path | Either **Floom bills them** (SaaS) or **they bill their users** (Connect) — product must eventually clarify | **E — Hidden API:** Power users reading `index.ts` OpenAPI or docs could call `/api/stripe/*`; ICP without those skills **never finds** monetization. **F — Wrong mental model:** User thinks “Floom will invoice me for usage” because of **cloud** language; actual near-term backend is **creator Connect** — different axis. |
| **4 — Deploy interest (repo→hosted)** | If marketing adds a waitlist form calling `POST /api/deploy-waitlist` | “I raised my hand for deploy; Floom will follow up.” | **G — Orphan API:** No in-repo web caller — form may be missing, duplicated, or **spam** table with no double-opt-in. **H — spec_url semantics:** Optional field; unclear if this is **OpenAPI URL**, **repo URL**, or **manifest** — ops ambiguity. |

**Enterprise / procurement sidebar (not ICP, but expectation collision):**

| Step | Buyer expectation | Floom today | Failure branch |
|------|-------------------|-------------|----------------|
| **Security / finance review** | Vendor holds funds or issues consolidated invoices; DPA; SOC2 | Connect model: **connected account is merchant of record**; Floom **application_fee** only | **I — Legal review confusion:** “Who is the merchant?” must be explained; **not** the same as “Floom invoices us for seats.” |
| **Roadmap shopping** | P3 Enterprise RBAC | RBAC deferred | **J — Monetization without governance:** Selling **creator** payments before **workspace controls** may alarm enterprise design partners. |

---

## 3. Risk register (P0 / P1 / P2)

| ID | Tier | Risk | Evidence | Downstream effect |
|----|------|------|----------|-------------------|
| M1 | **P0** | **Roadmap labels Stripe Connect as “backend stub” while server implementation is large and callable** — reviewers may **under-prioritize** security/review of `/api/stripe` | `ROADMAP.md` row “Stripe Connect monetization \| Backend stub”; `apps/server/src/routes/stripe.ts`, `stripe-connect.ts` | Under-tested production deploy with keys; **incident** or **compliance** surprise; PM/engineering misalignment on “done” |
| M2 | **P0** | **Two billing stories** (**Floom cloud subscription** in Studio stub vs **creator Stripe Connect** in backend) without a **single diagram** or page — users and GTM will conflate them | `StudioSettingsPage.tsx` “Cloud plan”; `stripe-connect.ts` direct charges + application fee | Support debt; wrong ICP attracted (“I only want SaaS pricing”) or wrong enterprise pitch (“we need usage invoices from Floom”) |
| M3 | **P1** | **Connect onboarding default URLs** point to `https://cloud.floom.dev/billing/{refresh,return}` unless env overrides — **404 or wrong product** if those routes are not shipped | `stripe-connect.ts` `STRIPE_CONNECT_ONBOARDING_*` defaults | Broken KYC loop; creator drop-off at Stripe handoff |
| M4 | **P1** | **Webhook handling** stores events but **does not** drive run metering, balances, or in-app receipts (`W4.x` noted in code) | `stripe-connect.ts` `dispatchEvent` for payment events | Finance and creators lack **truth** inside Floom UI; disputes rely on Stripe Dashboard only |
| M5 | **P1** | **`deploy_waitlist` table** accepts arbitrary emails with **no** visible product consent flow in-repo | `deploy-waitlist.ts`; no `apps/web` usage found | GDPR/marketing-consent gap if wired to a public form; **duplicate rows** (no unique constraint on email) |
| M6 | **P2** | **Naming collision:** `AppStripe` component vs Stripe Inc. | `AppStripe.tsx` | Harmless technically; **confuses** engineers grep-ing for payment work |
| M7 | **P2** | **“Billing (soon)” vs “Coming v1.1”** — two **timeline** phrases for the same theme | `StudioSidebar.tsx`, `StudioSettingsPage.tsx` | Minor trust nit; suggests **undecided** scheduling |

---

## 4. Open PM questions (numbered)

1. **Roadmap language:** Should “Stripe Connect monetization” move from **“backend stub”** to **“backend shipped, UI + metering deferred”** so security and GTM treat it as **live surface area**?
2. **Single revenue narrative for Studio Billing v1:** Will the first shippable Billing page prioritize **(A)** Floom **Cloud plan** checkout, **(B)** creator **Connect** onboarding, or **(C)** a **chooser** — and which is default for the ICP?
3. **Pricing truth:** What are the **quantified** limits for “longer-running jobs, live updates, managed sign-in keys” in the stub copy — otherwise should the card say **“details TBD”** explicitly?
4. **Cadence alignment:** Is **v1.1** the canonical external promise for Billing, or should UI copy track **ROADMAP P2 “month one”** for Connect specifically?
5. **`deploy_waitlist` ownership:** Is this endpoint **official** for the **repo→hosted** waitlist, and should the web app own a **consenting** form + **deduped** emails before P0 deploy marketing spend?
6. **Enterprise path:** For design partners asking for **invoicing / SOC2 / RBAC**, do we **explicitly** position Stripe Connect monetization as **out of scope** until P3, or ship a **“Floom invoices the company”** track separately?
7. **Application fee transparency:** Should end-users of paid creator apps see **“includes platform fee”**-style disclosure (jurisdiction-dependent), and who owns copy — Floom, creator, or Stripe Checkout defaults only?
8. **Anonymous / OSS mode:** Connect rows use `device:<id>` for unauthenticated owners (`stripe-connect.ts`). Is **creator monetization** allowed in OSS/self-host, or **cloud-gated** only — and where is that stated for operators?

---

## Appendix A — `ROADMAP.md` Stripe-related rows (verbatim theme)

| Location | Text |
|----------|------|
| Shipped backend, UI pending | “Stripe Connect monetization \| Backend stub, UI deferred to v1.1+” |
| P2 — Month one | “Stripe Connect UI” |

---

## Appendix B — Route map (server)

| Method | Path | Auth / notes |
|--------|------|----------------|
| POST | `/api/stripe/connect/onboard` | Session / user context (`resolveUserContext`) |
| GET | `/api/stripe/connect/status` | Same |
| POST | `/api/stripe/payments` | Same |
| POST | `/api/stripe/refunds` | Same |
| POST | `/api/stripe/subscriptions` | Same |
| POST | `/api/stripe/webhook` | **Stripe-Signature** only (documented in `index.ts`) |
| POST | `/api/deploy-waitlist/` | Public JSON body; validates email contains `@` |

---

*End of pd-12 — Monetization and deferred value.*
