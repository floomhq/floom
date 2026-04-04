# Floom Product Issues

*Single source of truth for product feedback. Updated after every interview round.*

**Label taxonomy:**
- `type:` `bug` `feature` `ux` `dx` (agent/dev experience)
- `priority:` `p0` (blocks launch) `p1` (next sprint) `p2` (backlog)
- `area:` `ui` `floomit` `api` `execution` `auth` `observability`
- `source:` `fede` `user-interview` `agent`

---

## UI / App Shell

### [04.04.26] Smart feedback/help widget (floating button)
`type:feature` `priority:p1` `area:ui` `source:fede`
- **What:** No in-app feedback or help mechanism.
- **Expected:** Floating button (bottom-right, not Intercom-style). Opens a panel with text + voice input. AI agent parses intent and routes to one of two paths:
  - **Feedback**: creates a ticket scoped to platform level OR the specific automation. User can subscribe to stay updated.
  - **Help**: agent answers inline using docs, offers relevant links or navigation guidance.
- **Key insight:** Single free-text input — agent classifies, user doesn't choose. Lowers the bar for feedback and collapses two widgets into one.
- **GitHub:** vbakhteev/deploy-tool#3

### [03.04.26] Code tab — version history missing
`type:feature` `priority:p1` `area:ui` `source:fede`
- **What:** Code tab only shows the current version, not previous ones.
- **Expected:** Browse, diff, and roll back to any previous version.

### [03.04.26] Run panel — input/output width imbalance
`type:ux` `priority:p1` `area:ui` `source:fede`
- **What:** Input panel on the left is too wide relative to the output panel on the right.
- **Expected:** Better proportion. Consider equal split or output-dominant layout.

### [03.04.26] Run panel — missing active/inactive states
`type:ux` `priority:p1` `area:ui` `source:fede`
- **What:** Left (input) and right (output) panels have no visual active/inactive distinction.
- **Expected:** Active panel is visually clear during and after a run. Inactive panel is muted.

### [03.04.26] Missing secrets / ENV variables tab
`type:feature` `priority:p0` `area:ui` `source:fede`
- **What:** No tab to view, add, or manage secrets / ENV vars per app or workspace.
- **Expected:** Dedicated "Secrets" tab — users set ENV vars without touching the API.

---

## Deploy Agent (floomit)

### [03.04.26] Deploy agent should offer to test itself after deployment
`type:dx` `priority:p1` `area:floomit` `source:fede`
- **What:** After a successful deploy, nothing happens. No prompt to verify.
- **Expected:** Agent says: "Your app is live. Want me to run a test now?"

### [03.04.26] Rename "deploy agent" to "floomit"
`type:dx` `priority:p0` `area:floomit` `source:fede`
- **What:** The deploy agent has no brand name.
- **Expected:** All references (UI, docs, skill name) use "floomit."

---

## Environments

### [03.04.26] Test vs live (sandbox vs production)
`type:feature` `priority:p0` `area:execution` `source:user-interview`
- **What:** No separation between a test and a live version of an app.
- **Expected:** Every app has "test" and "live" environments. Changes in test don't touch production. Language is non-technical.
- **Interviews:** Jonas, Dont Gate, Paul synthesis

### [03.04.26] Regression tests + rollback
`type:feature` `priority:p1` `area:execution` `source:user-interview`
- **What:** No way to run regression checks or roll back when something breaks.
- **Expected:** Automated rollback on regression (error spike, Slack report). Visual changelog between versions.
- **Interviews:** Mahir

---

## Access & Permissions

### [03.04.26] Scoped / read-only API keys
`type:feature` `priority:p1` `area:auth` `source:user-interview`
- **What:** Apps run with full API access. No scoping to read-only or limited permissions.
- **Expected:** Per-app or per-workspace API key scoping. Read-only mode. Reduces blast radius.
- **Interviews:** Mahir (unprompted)

### [03.04.26] Role-based permissions for publishing
`type:feature` `priority:p1` `area:auth` `source:user-interview`
- **What:** No control over who can publish an app publicly vs. keep it internal.
- **Expected:** Org-level roles: viewer, builder, publisher. Admins restrict what gets published.
- **Interviews:** Sebastian, Jonas

### [03.04.26] IP ownership / agent ownership
`type:feature` `priority:p2` `area:auth` `source:user-interview`
- **What:** No concept of org-level ownership when an employee creates an app.
- **Expected:** All apps created in a workspace belong to the org. Apps don't leave with the employee.
- **Interviews:** Jonas

---

## Observability

### [03.04.26] Observability dashboard
`type:feature` `priority:p0` `area:observability` `source:user-interview`
- **What:** No central dashboard for all deployed apps, their status, runs, errors, alerts.
- **Expected:** Dashboard with: all apps, run status, error alerts, last run time, job history.
- **Interviews:** Tim (clearest ask), Mahir ("internal OS")

### [03.04.26] API key expiry alerts
`type:feature` `priority:p1` `area:observability` `source:user-interview`
- **What:** When a secret expires, the app silently fails. No notification.
- **Expected:** Alert to workspace owner when a key expires or a run fails with an auth error.
- **Interviews:** Tim

---

## Integrations

### [03.04.26] Google Sheets integration
`type:feature` `priority:p0` `area:api` `source:user-interview`
- **What:** No first-class Google Sheets connector. Teams use Sheets as their primary DB/CRM.
- **Expected:** Read/write Sheets natively as a first-class input/output type. No custom code needed.
- **Interviews:** Tim, Dont Gate, Nisa AI — 3 of 5 interviewees use Sheets as primary data store

### [03.04.26] Slack integration (deployment target)
`type:feature` `priority:p1` `area:api` `source:user-interview`
- **What:** Apps can't be deployed to Slack. Slack is the daily interface for many teams.
- **Expected:** Deploy an app as a Slack bot — trigger via message, output in channel.
- **Interviews:** Dont Gate, Jan (CTO)

### [03.04.26] Notion integration
`type:feature` `priority:p1` `area:api` `source:user-interview`
- **What:** No Notion connector for reading/writing data or triggering workflows.
- **Expected:** Read/write Notion databases as input/output type.
- **Interviews:** Jan (CTO), Paul synthesis

### [03.04.26] HubSpot integration
`type:feature` `priority:p2` `area:api` `source:user-interview`
- **What:** No HubSpot connector.
- **Expected:** Read/write HubSpot contacts, deals, activities as input/output.
- **Interviews:** Liam, Sebastian

---

## Client-Facing Layer

### [03.04.26] White-label / branded UI
`type:feature` `priority:p1` `area:ui` `source:user-interview`
- **What:** Apps are served under floom's branding. Clients see "floom," not the agency's brand.
- **Expected:** White-label: custom domain, logo, colors. Clients see the agency's brand.
- **Interviews:** Tim ("branded experience = premium"), Jonas

### [03.04.26] Client billing pass-through
`type:feature` `priority:p2` `area:api` `source:user-interview`
- **What:** No way to bill clients for app usage or pass hosting costs through.
- **Expected:** Per-workspace billing, client invoicing, or usage-based pass-through.
- **Interviews:** Tim

---

## Human-in-the-Loop (HITL)

### [03.04.26] HITL / approval step before action
`type:feature` `priority:p1` `area:execution` `source:user-interview`
- **What:** Agents run fully autonomously with no way to pause for human approval.
- **Expected:** Apps can define approval steps — e.g. "show draft to human before sending."
- **Interviews:** Dont Gate, Christine, Paul synthesis

### [03.04.26] Guardrail agent (agent validating agent output)
`type:feature` `priority:p1` `area:execution` `source:user-interview`
- **What:** No built-in mechanism to validate an agent's output before it reaches an end user.
- **Expected:** Optional guardrail layer: secondary check catches errors or hallucinations before output is shown.
- **Interviews:** Mahir

---

## Output Types

### [04.04.26] PDF generation
`type:feature` `priority:p1` `area:execution` `source:fede`
- **What:** Automations cannot output a PDF.
- **Expected:** Output type `pdf` — automation returns a rendered PDF, user can download it.

### [04.04.26] HTML generation
`type:feature` `priority:p1` `area:execution` `source:fede`
- **What:** Automations cannot output rendered HTML.
- **Expected:** Output type `html` — platform renders it inline or as a preview.

### [04.04.26] HTML to PDF
`type:feature` `priority:p1` `area:execution` `source:fede`
- **What:** No built-in HTML → PDF conversion.
- **Expected:** Platform handles the conversion natively. Apps don't manage headless Chrome themselves.

### [04.04.26] Generic file output type
`type:feature` `priority:p1` `area:execution` `source:user-interview`
- **What:** Automations can only output structured types (text, table, integer, html, pdf). No way to return an arbitrary downloadable file (CSV, TXT, custom format, Excel, zip, etc.).
- **Expected:** Output type `file` — automation returns any file as bytes/base64 with a declared MIME type and filename. Platform shows a download button. Covers ML pipeline outputs, data transformations, generated reports in non-standard formats.
- **Interviews:** Jan Kühnen (ML decision support tools: CSV/TXT in → new file format out)

### [04.04.26] Large file input support
`type:feature` `priority:p1` `area:execution` `source:user-interview`
- **What:** File inputs receive an R2 URL, but very large files (multi-MB CSV, TXT) hit memory/timeout limits in E2B sandboxes. No streaming or chunked processing.
- **Expected:** Large file inputs are streamed or chunked transparently. Automations processing big datasets don't time out.
- **Interviews:** Jan Kühnen (aerospace ML tools with "riesige Dateien")
