# ax-07 — Microcopy consistency (`apps/web/src`)

**Scope:** Grep-driven scan for `secret` / `Secret`, `credential` / `Credential`, `API key`, `publish` / `Publish`, `deploy` / `Deploy`, `host` / `Host` under `apps/web/src`. Code unchanged; deliverable only.

**ICP lens:** Primary user is a **non-developer AI engineer** with a localhost prototype who needs production hosting. Copy should not assume they map “credentials,” “API keys,” “tokens,” and “secrets” to the same place in the product, or that “Settings” exists next to “Secrets” unless the UI actually shows that.

**Related:** `docs/PRODUCT.md` (three surfaces, ingest modes); route model `/me/apps/:slug/secrets` vs `/studio/:slug/secrets`.

---

## Glossary recommendation (canonical user-facing terms)

Use one primary noun per surface in the product UI; qualify in subtext when the thing is not the same object.

| Concept | Recommended primary term | When to qualify | Avoid for UI chrome |
|--------|---------------------------|-----------------|---------------------|
| Per-user or per-app values stored in `/api/secrets` (encrypted vault) | **Secrets** | In body copy: “API keys, tokens, or cookies the app lists in its manifest” | Mixing **Credentials** as the page title when the nav says **Secrets** |
| Programmatic access to Floom HTTP/MCP (future per-app keys; PAT in settings) | **API keys** or **access tokens** | Always disambiguate: “Creator API keys (CLI)” vs “App secrets (run time)” | Calling PATs “secrets” next to app **Secrets** without context |
| Putting an app live / into the directory | **Publish** | “Share the link” is fine; avoid “deploy” in hero CTAs | **Deploy** as the user verb unless talking to infra-aware readers (docs/protocol) |
| Floom running the container vs wrapping an external API | **Hosted mode** / **Proxied mode** (protocol) | “Floom hosts the runtime” vs “your API stays where it is” | Overloading **host** (network hostname vs “we host your app”) in the same sentence |

**Rule of thumb for errors:** The recovery path string should mirror real navigation: tab labels (`Secrets`), Studio sidebar (`Secrets`), or explicit URLs—**not** a fictional `Settings → Secrets` breadcrumb unless that hierarchy ships.

---

## Cluster A — Secrets, credentials, API keys, tokens

### Where “Secrets” is the chrome (consistent)

- `MeAppSecretsPage.tsx` — page titles “Secrets for {app}”, empty state “doesn’t declare any secrets”, footer “Secrets are AES-256 encrypted…”
- `MeAppPage.tsx` — tab label `Secrets`, CTA “Manage secrets”
- `StudioSidebar.tsx` — nav label `Secrets`
- `Sidebar.tsx` — section “Secrets” / “No secrets required.”
- `OutputPanel.tsx` — link label “Open Secrets”; `secretsUrl` → `/me/apps/:slug/secrets`

### Mixed vocabulary (same feature, different words)

| Pattern | Example | File |
|--------|---------|------|
| Headline **secret**, body **API key** | “This app needs a **secret**” / “Add the missing **API key** under…” | `components/runner/OutputPanel.tsx` (~805–806) |
| **Credentials** headline, implementation is `setSecret` | “This app needs **credentials** to run” | `components/me/SecretsRequiredCard.tsx` (~157) |
| Page titled **Secrets**, subtitle **credentials** | “Secrets for {app}” / “Provide the **credentials** this app needs…” | `pages/MeAppSecretsPage.tsx` (~220–232) |
| **credentials** + **secret** in one sentence | “Floom has no **credentials** set… add a **secret** in Studio → Secrets” | `components/runner/OutputPanel.tsx` (~948) |
| Legal **API keys** | “Inputs, run outputs, **API keys**…” | `pages/TermsPage.tsx` (~58) |
| Legal / privacy **API keys** | Usage data lists “**API keys** you add” | `pages/PrivacyPage.tsx` (~147) |
| Studio **Creator API keys** + stub **Personal access tokens** | Section title vs card title | `pages/StudioSettingsPage.tsx` (~87–91) |
| Per-app **API keys** (bearer for callers) | Heading “**API keys**” under Access | `pages/StudioAppAccessPage.tsx` (~121–124) |
| Protocol marketing **Secrets vault** | Diagram list item | `pages/ProtocolPage.tsx` (~183) |

**ICP note:** A reader can believe “API keys” live under **Studio → Access** (future bearer keys) while manifest-backed values live under **Secrets**. Today’s error copy sometimes says “API key” + “Settings → Secrets,” which stacks two confusions (wrong nav + possible collision with Access keys).

---

## Cluster B — Recovery paths and navigation strings

| Copy | Issue | File |
|------|--------|------|
| “Add the missing API key under **Settings → Secrets**” | **Settings** is not the parent of **Secrets** on `/me/apps/:slug`: the tab bar has separate **Secrets** and a disabled **Settings** placeholder (`MeAppPage.tsx` ~192–195). Users cannot find “Settings → Secrets.” | `components/runner/OutputPanel.tsx` (~806) |
| Same “**Settings → Secrets**” for `GITHUB_TOKEN` | Same mismatch for creators hitting repo clone errors | `components/runner/OutputPanel.tsx` (~884) |
| “add a secret in **Studio → Secrets**” | Aligns with Studio sidebar (`StudioSidebar.tsx` ~355) for owners in Studio | `components/runner/OutputPanel.tsx` (~948) |
| Link “**Open Secrets**” | Matches destination `/me/apps/.../secrets` and tab name **Secrets** | `components/runner/OutputPanel.tsx` (~564–569) |

**Contradiction:** Same file uses **Settings → Secrets** (two places) and **Studio → Secrets** (one place) for related “missing auth material” situations—internally inconsistent and one path is factually wrong for current IA.

---

## Cluster C — Publish vs deploy

### User-facing “Publish” (dominant, consistent)

Representative: `BuildPage.tsx` (“Publish an app”, “Ready to publish”, “Publish as Public/Private”), `TopBar.tsx` (“Publish an app”), `CreatorHeroPage.tsx`, `StudioHomePage.tsx`, `MePage.tsx` (first-run publish card), `InstallPage.tsx`, `main.tsx` (tour/onboarding strings), `SignupToPublishModal`, etc.

### “Deploy” (minimal surface area)

- `main.tsx` — comment only: legacy nav labels “Deploy”, “Docs”… (~215)
- `components/home/SectionEyebrow.tsx` — JSDoc example “Deploy in minutes” (~10), not live copy
- `components/TopBar.tsx` — variable name `deployHref` points to `/studio/build` but the **visible** CTA text is **Publish an app** (~136, ~317–320, ~603–609)

**Assessment:** No strong user-visible **Deploy** vs **Publish** split in TSX UI; terminology is mostly **Publish**. Technical readers see “deployment modes” on the protocol page (below).

---

## Cluster D — Host / hosted / self-host / upstream host

### Product / marketing

- `CreatorHeroPage.tsx` — “Self-host in one command”, section `#self-host`
- `ProtocolPage.tsx` — “**Hosted mode**”, “Two **deployment** modes”, self-host one-liner
- `AboutPage.tsx`, `InstallPage.tsx`, `main.tsx` — self-host redirects and copy
- `WhyFloom.tsx` — “Self-host it, or use the hosted version”

### Technical (runner / types)

- `OutputPanel.tsx` — `upstreamHost`, “Couldn’t connect to {hostStr}” (network hostname; appropriate technical term)
- `lib/types.ts` — `upstream_host` field comment

**Assessment:** **Host** as “DNS/hostname” appears in error strings; **hosted** / **self-host** appear in positioning. Not contradictory if “Can’t reach X” stays clearly about the **remote service**, not “Floom hosting.”

---

## Cluster E — Other “secret” uses (intentionally distinct)

- `StudioTriggersTab.tsx` — webhook **secret** shown once at creation (trigger plumbing, not app vault)
- `TermsPage.tsx` — legal “trade **secrets**” (IP law, not product feature)
- `main.tsx` — regex for scrubbing logs (`password|token|api_key|…`) — not user copy

---

## Inconsistency list (actionable)

1. **`Settings → Secrets` does not exist in current app IA** — prefer “App → **Secrets** tab” or “**Studio** → **Secrets**” depending on audience; align with `MeAppPage.tsx` tab labels. (`OutputPanel.tsx` ~806, ~884)

2. **Secret vs credential vs API key** — same flows use all three; pick one primary (**Secrets**) in headlines and short errors; use “API keys, tokens, or cookies” only in explanatory subtext. (`SecretsRequiredCard.tsx`, `MeAppSecretsPage.tsx`, `OutputPanel.tsx`)

3. **`Studio → Secrets` vs `Settings → Secrets`** — three different wayfinding styles for related errors in one module. (`OutputPanel.tsx`)

4. **“Creator API keys” / “Personal access tokens” / “API keys” (Access)** — three related labels; glossary above recommends always scoping (“creator”, “per-app access”, “app secrets”). (`StudioSettingsPage.tsx`, `StudioAppAccessPage.tsx`)

5. **“Secrets vault” (protocol diagram)** vs nav **Secrets** — optional harmonization (“Secrets” or “Secrets (vault)” in one place only). (`ProtocolPage.tsx`)

---

## Method note

Strings in `api/client.ts` (`fetch` `credentials: 'include'`) and `sanitize.ts` (credential exfiltration) are web-platform terms, not product microcopy—excluded from inconsistency findings above.
