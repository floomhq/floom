# Per-route UX audit — `/studio/:slug/secrets`

**Date:** 2026-04-20  
**Route:** `/studio/:slug/secrets`  
**Entry component:** `StudioAppSecretsPage` (`apps/web/src/pages/StudioAppSecretsPage.tsx`)  
**Implementation:** Thin wrapper; all UI and data logic live in `MeAppSecretsPage` with `chrome="studio"` and `notFoundPath="/studio"`.

---

## 1. Code map (verified)

| File | Role |
|------|------|
| `apps/web/src/main.tsx` | `<Route path="/studio/:slug/secrets" element={<StudioAppSecretsPage />} />` |
| `apps/web/src/pages/StudioAppSecretsPage.tsx` | Re-exports `<MeAppSecretsPage chrome="studio" notFoundPath="/studio" />` — no duplicate markup. |
| `apps/web/src/pages/MeAppSecretsPage.tsx` | Breadcrumb, `getApp` + `getSecretPolicies`, creator vs viewer rows, empty states, error banners. |
| `apps/web/src/components/studio/StudioLayout.tsx` | Shell: cloud auth gate, sidebar (`activeSubsection="secrets"`), document title. |
| `apps/web/src/components/studio/StudioSidebar.tsx` | Nav link to `/studio/${slug}/secrets`. |

**Legacy parity:** `/me/apps/:slug/secrets` redirects to this route via `StudioSlugRedirect`, so runner “Open Secrets” (`OutputPanel` → `/me/apps/:slug/secrets`) still lands in Studio after one redirect.

---

## 2. ICP lens (`docs/PRODUCT.md`)

Floom’s ICP needs **secret injection without learning a secrets manager**. This page is load-bearing for the promise that creators can **choose who supplies each key** (creator vs per-user vault) and set shared values. Anything that reads as “nothing to do here” after a run-time **authentication** failure breaks trust and matches the launch audit’s **S1** gap (see section 5).

---

## 3. UX checklist pass (condensed)

Reference: `~/.claude/skills/ui-audit/references/ux-review-checklist.md`.

| Area | Assessment |
|------|-------------|
| **First impression** | Clear: “Secrets for {name}” + short explainer for creator vs non-creator. Studio sidebar reinforces place. |
| **Hierarchy** | Header → explainer → main list or empty card → footnote on encryption. Sensible. |
| **Wayfinding** | Studio: breadcrumb `{app} › Secrets` when `app` is loaded; sidebar highlights Secrets. |
| **Interaction** | Creator: policy chips, password inputs, Save/Delete with confirm on delete. Non-creator: vault rows. Toggle is optimistic with rollback + inline error. |
| **Copy** | Mostly plain language; “manifest” is not surfaced to users (good). |
| **Empty states** | **See section 5** — creator empty when `secrets_needed` is `[]` is accurate for the manifest but can contradict upstream reality. |
| **Error states** | Red banner for `getApp` failures; amber for `getSecretPolicies` failure. |
| **Loading** | Until `app` loads, main heading/body below errors are absent; `StudioLayout` shows `RouteLoading` while session pending. No skeleton for app body during `getApp`. |
| **Accessibility** | Breadcrumb `nav` with `aria-label`; policy control uses `role="tablist"` / `role="tab"`. Secret inputs rely on `code` key name + context; no separate `<label>` for each password field (checklist gap). |
| **Mobile** | Inherits StudioLayout (sidebar drawer); dense forms — acceptable for creator tooling, not primary ICP mobile path. |

---

## 4. Studio-specific behavior vs `/me`

- **Auth:** `chrome="studio"` uses `StudioLayout`, which redirects signed-out cloud users to `/login?next=…` (see `StudioLayout.tsx`).
- **`getApp` 404:** `navigate(notFoundPath ?? '/me')` → `/studio` when wired from `StudioAppSecretsPage`.
- **`getApp` 403 when `chrome === 'studio'`:** Silent redirect to `/p/:slug` (treats user as non-owner / no access). **No inline message** explaining loss of Studio access — user may be surprised compared to a generic error on `/me`.
- **Tab bar:** Omitted in Studio (sidebar replaces `TabBar`).

---

## 5. Focus: empty `secrets_needed` vs `auth_error` (critical UX gap)

**What the UI does:** `neededKeys = app?.manifest?.secrets_needed ?? []`. If `neededKeys.length === 0`, the creator sees a dashed card (`data-testid="me-app-secrets-empty"`):

> “This app doesn’t declare any secrets. Nothing to configure here.”

**What runs can still say:** On `auth_error`, `OutputPanel` / `classifyRunError` tells owners: Floom has no credentials; **“add a secret in Studio → Secrets”** and offers **Open Secrets** (via `/me/apps/…/secrets` → redirect here).

**The contradiction:** For OpenAPI / proxied apps, upstream **401/403** can occur when credentials exist only **per operation**, **OAuth-only** security, or **ingest** did not populate top-level `manifest.secrets_needed` — while the runner still classifies the failure as **`auth_error`**. The user follows product copy into Studio Secrets and hits an empty state that implies the problem is “declared secrets,” not “upstream rejected the call.” That is a **dead end** for the ICP (aligned with **C1** in `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md`).

**Severity:** Treat as **S1/S2** cross-surface consistency (runner → Studio), not a cosmetic copy tweak on this page alone.

**What would make this page honest (product + eng, out of scope for this doc):**

1. Align **`secrets_needed`** with the **union** of keys the runner actually needs (including per-action / ingest-derived keys), **or**
2. When `secrets_needed` is empty but the user arrived from / is linked for **credential** issues, show **differentiated copy** (e.g. point to manifest / OpenAPI security / hub `secrets` config) instead of the generic “doesn’t declare any secrets” card.

---

## 6. Other edge notes

- **Non-creator empty:** If every key is `creator_override`, viewers see a distinct empty message (“The creator of this app supplies every required secret…”). Good differentiation from the `secrets_needed === []` case.
- **`policiesError`:** “Couldn’t load secret policies: …” — user may see **AppHeader + explainer + policies error** but **no rows** if keys exist; clearer than a blank list. Retry path is implicit (refresh only).
- **Duplicate `data-testid`:** Both creator “no keys” and viewer “all creator_override” use `me-app-secrets-empty`; automation may conflate them.
- **`buildAuthError` subcopy** references “Studio → Secrets” while the link target is still `/me/apps/…/secrets` (redirects to Studio) — functionally OK, mental model slightly split.

---

## 7. Scoring (after flaws above)

| Dimension | Weight | Score (1–10) | Note |
|-----------|--------|----------------|------|
| Clarity | 25% | 7 | Strong when manifest matches runtime needs. |
| Efficiency | 20% | 8 | Few steps to set policy + value. |
| Consistency | 15% | 5 | Runner/auth messaging vs empty secrets page. |
| Error handling | 15% | 6 | Inline errors good; 403 studio redirect opaque; empty/auth mismatch. |
| Mobile | 15% | 6 | Acceptable for studio admin. |
| Delight | 10% | 6 | Policy toggle + auto-focus are thoughtful. |

**Overall (weighted):** ~6.5 — **dragged down by consistency / error-story alignment** when `secrets_needed` is empty.

---

## 8. Files referenced

- `apps/web/src/pages/StudioAppSecretsPage.tsx`
- `apps/web/src/pages/MeAppSecretsPage.tsx`
- `apps/web/src/components/studio/StudioLayout.tsx`
- `apps/web/src/components/runner/OutputPanel.tsx` (`secretsUrl`, `auth_error`, `missing_secret_prompt`)
- `docs/PRODUCT.md`
- `docs/ux-audit/LAUNCH-UX-AUDIT-2026-04-20.md` (C1, M1)
