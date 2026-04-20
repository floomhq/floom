# ax-13 — Dead / legacy routes (`Navigate`, `/_creator-legacy`, `/_build-legacy`)

**Scope:** Client routes in `apps/web/src/main.tsx` that use `<Navigate>`, hard `ExternalRedirect`, param-based redirect components, and the underscore-prefixed legacy mounts. **Method:** read `main.tsx` (2026-04-20) + ripgrep across the repo for path strings. **Related:** `docs/PRODUCT.md` (preserve public surfaces, three surfaces, no careless deletion); `AGENTS.md` (prefer `docs/deprecated/` when ambiguous); `docs/extended-audit/INDEX.md` row 13.

**Classification key**

| Label | Meaning |
|-------|---------|
| **Keep** | Canonical surface users or operators should use long-term. |
| **Redirect forever** | Not canonical, but bookmarks / wireframes / docs / HTML stubs may still point here; removal would break links without a staged migration. |
| **Deprecate with doc** | Intentionally non-canonical or internal; no in-repo navigation found; document intent (and optionally add `docs/deprecated/<name>.md` if the team wants a durable pointer) before any future removal. |

---

## 1. `Navigate` and redirect helpers in `main.tsx`

| Path / pattern | Mechanism | Target | In-repo links (grep, non-router) | Recommendation |
|----------------|-----------|--------|-----------------------------------|----------------|
| `/p/:slug/dashboard` | `PSlugDashboardRedirect` → `<Navigate>` | `/creator/:slug` → then `/studio/:slug` via route below | **None** (only `main.tsx` defines the path) | **Redirect forever** — wireframe URL; comment documents v11 preview. |
| `/me/a/:slug` | `MeAppRedirect` | `/me/apps/:slug` → `StudioSlugRedirect` → `/studio/:slug` | **None** (only `main.tsx`) | **Redirect forever** — v15.2 short form; comment says preview-only. |
| `/me/a/:slug/secrets` | `MeAppSecretsRedirect` | `/me/apps/.../secrets` → studio | **None** | **Redirect forever** |
| `/me/a/:slug/run` | `MeAppRunRedirect` | `/me/apps/.../run` (**stays** on `MeAppRunPage`) | **None** | **Redirect forever** |
| `/me/apps/:slug` | `StudioSlugRedirect` | `/studio/:slug` | Many (`MeRail`, `OutputPanel`, `BuildPage`, `CreatorAppPage`, `MeAppPage` tabs, etc.) — intentional hop | **Redirect forever** — deep links and UI still emit `/me/apps/...`; router replaces URL to `/studio/...`. |
| `/me/apps/:slug/secrets` | `StudioSlugRedirect` | `/studio/:slug/secrets` | Same family as above | **Redirect forever** |
| `/build` | `<Navigate replace>` | `/studio/build` | `index.html` (noscript), `MeRail.tsx`, `CreatorPage.tsx` (`to="/build"`), `BuildPage.tsx` (`next=/build`), docs (`SELF_HOST.md`, `connections.md`, `ROADMAP.md`, audits, `README` copy in places) | **Redirect forever** — public CTA path; `docs/PRODUCT.md` roadmap language still names `/build`. |
| `/creator` | `<Navigate replace>` | `/studio` | `README.md`, `DEFERRED-UI.md`; `CreatorAppPage.tsx` / `BuildPage.tsx` use `/creator` / back href | **Redirect forever** |
| `/creator/:slug` | `StudioSlugRedirect` | `/studio/:slug` | Indirect via `/p/:slug/dashboard` chain | **Redirect forever** |
| `/browse` | `<Navigate replace>` | `/apps` | **None** in TSX/TS/HTML besides `main.tsx` | **Redirect forever** — vanity / TopBar alias per comment. |
| `/deploy` | `<Navigate replace>` | `/studio/build` | **None** besides `main.tsx` | **Redirect forever** |
| `/docs` | `<Navigate replace>` | `/protocol` | **None** as path string in app TSX besides `main.tsx` | **Redirect forever** |
| `/docs/protocol` | `<Navigate replace>` | `/protocol` | **None** | **Redirect forever** |
| `/docs/self-host` | `<Navigate replace>` | `/protocol#self-hosting` | `CreatorHeroPage.tsx` (`to="/docs/self-host"`) | **Redirect forever** |
| `/docs/api-reference` | `<Navigate replace>` | `/protocol#api-surface` | **None** | **Redirect forever** |
| `/docs/rate-limits` | `<Navigate replace>` | `/protocol#plumbing-layers-auto-applied` | **None** | **Redirect forever** |
| `/docs/changelog` | `ExternalRedirect` | `https://github.com/floomhq/floom/releases` | **None** | **Redirect forever** (off-site; stable destination). |
| `/docs/*` | `<Navigate replace>` | `/protocol` | **None** (catch-all) | **Redirect forever** |
| `/self-host` | `<Navigate replace>` | `/#self-host` | **None** | **Redirect forever** |
| `/onboarding` | `<Navigate replace>` | `/me?welcome=1` | **None**; server sets title for `/onboarding` in `apps/server/src/index.ts` | **Redirect forever** — wireframe + SSR title acknowledge the URL. |
| `/pricing` | `<Navigate replace>` | `/` | **None** | **Redirect forever** |
| `/store` | `<Navigate replace>` | `/apps` | **None** | **Redirect forever** |
| `/legal/imprint` | `<Navigate replace>` | `/legal` | **None** | **Redirect forever** — comment: sitemap / older builds. |
| `/legal/privacy` | `<Navigate replace>` | `/privacy` | **None** | **Redirect forever** |
| `/legal/terms` | `<Navigate replace>` | `/terms` | **None** | **Redirect forever** |
| `/legal/cookies` | `<Navigate replace>` | `/cookies` | **None** | **Redirect forever** |
| `/impressum` | `<Navigate replace>` | `/legal` | **None** | **Redirect forever** |

**Notes**

- `<Navigate replace>` preserves the product expectation that old URLs do not strand users; this matches `docs/PRODUCT.md` spirit (“do not simplify public surfaces without discussion”) and `AGENTS.md` (avoid breaking bookmarks when ambiguity exists).
- `/me/apps/:slug/run` is **not** a `<Navigate>` row: it is a **Keep** first-class route (`MeAppRunPage`) per comments (consumer “run” surface vs studio management).

---

## 2. `/_creator-legacy` and `/_build-legacy`

Defined in `main.tsx`:

```209:213:apps/web/src/main.tsx
        <Route path="/_creator-legacy" element={<CreatorPage />} />
        <Route path="/_creator-legacy/:slug" element={<CreatorAppPage />} />
        <Route path="/_build-legacy" element={<BuildPage />} />
```

Comment on the preceding block: *“Kept reachable for tooling that might import them directly, but no nav links to them anymore.”*

**Ripgrep for `_creator-legacy`, `_build-legacy`, `creator-legacy`, `build-legacy` (repo-wide):**

| Match | Role |
|-------|------|
| `apps/web/src/main.tsx` | Route definitions only |
| `docs/extended-audit/INDEX.md` | This audit index row |

**Conclusion:** No `href`, `Link`, `navigate(`, or docs copy targets these URLs. They are **deliberately hidden** legacy mounts of `CreatorPage`, `CreatorAppPage`, and `BuildPage`.

| Route | Mounted component | Recommendation |
|-------|-------------------|----------------|
| `/_creator-legacy` | `CreatorPage` | **Keep** *or* **Deprecate with doc** — **Keep** if QA/tooling still needs pre–Studio chrome without maintaining a second public URL scheme; **Deprecate with doc** (optional `docs/deprecated/underscore-legacy-ui-routes.md`) so the team agrees they are not a supported user surface and must not appear in marketing or protocol docs. **Do not delete** without the `docs/PRODUCT.md` deletion paragraph (“what pillar, what replaces it?”) — pages implement real creator/build flows tied to hosting narrative, even if primary UX is `/studio/*`. |
| `/_creator-legacy/:slug` | `CreatorAppPage` | Same as above |
| `/_build-legacy` | `BuildPage` | Same as above |

---

## 3. Related server-side legacy (outside `main.tsx`, same theme)

| Path | Behavior | Source | Recommendation |
|------|----------|--------|----------------|
| `/spec`, `/spec/*` | **308** to `/protocol` (with `.md` suffix stripped) | `apps/server/src/index.ts` (~826–837) | **Redirect forever** — complements SPA `/docs/*` redirects; crawlers may hit SSR first. |

---

## 4. Recommendations (summary)

1. **Vanity and v15/v16 redirects** (`/build`, `/creator`, `/docs/*`, `/browse`, `/deploy`, `/store`, `/pricing`, `/onboarding`, `/self-host`, legal aliases, `/me/a/*`, `/p/:slug/dashboard`, `/me/apps/:slug` non-run): treat as **redirect forever** unless product explicitly sunsets a URL and communicates a migration. None of these are “dead” — they are compatibility layers.
2. **`/_creator-legacy*` / `/_build-legacy`:** no in-repo links; safe to treat as **internal escape hatches**. Per `AGENTS.md`, if someone later proposes **removal**, add **`docs/deprecated/`** (or extend `PRODUCT.md`) *before* deleting, and confirm no external tooling depends on the raw paths. Until then, **Keep** with optional short **deprecate-with-doc** note for operator clarity.
3. **Docs drift:** several markdown files still talk about `/creator` and `/build` as primary dashboards (`README.md`, `DEFERRED-UI.md`). That is **documentation accuracy**, not a routing bug — redirects make links work; updating copy to `/studio` and `/studio/build` is a separate editorial task (out of scope for this audit file).

---

## 5. `docs/PRODUCT.md` alignment

- Load-bearing table in `PRODUCT.md` does **not** list `main.tsx` routes or the underscore paths. Nothing in this audit proposes deleting server MCP routes, `/p/:slug`, or packages called out there.
- Preserving `<Navigate replace>` chains for old URLs supports the ICP (“paste repo, get hosted”) by avoiding 404s for anyone following older links — consistent with “preserve public surfaces” and “prefer deprecated redirects over hard deletion when in doubt.”
